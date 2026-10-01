import type { GatewayEvent } from '@hermes/shared'
import { useCallback } from 'react'

import { gatewayEventCompletedFileDiff } from '@/lib/gateway-events'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { reachablePreviewUrl } from '@/lib/preview-reach'
import {
  $previewTabs,
  beginPreviewServerRestart,
  closeBrowserPreviewMatchingLiveUrl,
  closeDockedPreviewMatching,
  closeRightRail,
  completePreviewServerRestart,
  openPreview,
  progressPreviewServerRestart,
  renderedHtmlTarget,
  requestPreviewReload
} from '@/store/preview'
import { $activeSessionId, $currentCwd, $selectedStoredSessionId } from '@/store/session'
import { $focusedStoredSessionId } from '@/store/session-focus'
import { $focusedRuntimeId, $sessionTiles } from '@/store/session-states'

type EventHandler = (event: GatewayEvent) => void

interface PreviewRoutingOptions {
  baseHandleGatewayEvent: EventHandler
  currentCwd: string
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
}

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function sessionIsOnScreen(sessionId: string): boolean {
  return (
    sessionId === $focusedRuntimeId.get() ||
    sessionId === $activeSessionId.get() ||
    $sessionTiles.get().some(tile => tile.runtimeId === sessionId)
  )
}

/** The STORED id of the session a gateway event names — so the tab lands in
 *  the drawer of the chat that ASKED for the preview, not whichever chat
 *  happens to hold focus. The active runtime names the primary's selection; a
 *  tiled runtime names its tile. Unresolvable (or absent) session ids read as
 *  null and fall back to focus. */
function storedIdForEventRuntime(runtimeId: unknown): null | string {
  if (typeof runtimeId !== 'string' || !runtimeId) {
    return null
  }

  if (runtimeId === $activeSessionId.get()) {
    return $selectedStoredSessionId.get()
  }

  return $sessionTiles.get().find(tile => tile.runtimeId === runtimeId)?.storedSessionId ?? null
}

export function usePreviewRouting({ baseHandleGatewayEvent, currentCwd, requestGateway }: PreviewRoutingOptions) {
  const restartPreviewServer = useCallback(
    async (url: string, context?: string) => {
      const sessionId = $focusedRuntimeId.get()

      if (!sessionId) {
        throw new Error('No active session for background restart')
      }

      const cwd = $currentCwd.get() || currentCwd || ''

      const result = await requestGateway<{ task_id?: string }>('preview.restart', {
        context: context || undefined,
        cwd: cwd || undefined,
        session_id: sessionId,
        url
      })

      const taskId = result.task_id || ''

      if (!taskId) {
        throw new Error('Background restart did not return a task id')
      }

      beginPreviewServerRestart(taskId, url)

      return taskId
    },
    [currentCwd, requestGateway]
  )

  const handleDesktopGatewayEvent = useCallback<EventHandler>(
    event => {
      baseHandleGatewayEvent(event)

      if (event.type === 'preview.open') {
        // Agent-driven open in response to an explicit user request ("show
        // cnn.com in the preview pane"). Honor it for any session that's ON
        // SCREEN — the primary chat or an open tile — not only the focused
        // one: the turn's window routing already scoped the event to this
        // window, and gating on focus made the open silently vanish whenever
        // the user's click had moved focus to a different zone by the time
        // the tool ran (an "open reddit" they explicitly asked for). A
        // session that is NOT visible anywhere still can't yank the pane
        // open (offer, don't hijack). Routes through the same normalizer as
        // the file browser so URLs, localhost, and file paths all resolve.
        const { url, label } = asRecord(event.payload)
        const target = typeof url === 'string' ? url.trim() : ''

        if (target && (!event.session_id || sessionIsOnScreen(event.session_id))) {
          // The tab belongs to the session that asked — the event's runtime
          // resolved to its stored id. A tile's open lands in the TILE's
          // drawer even while main (or another tile) holds focus.
          const ownerStoredSessionId = storedIdForEventRuntime(event.session_id)

          void normalizeOrLocalPreviewTarget(target, $currentCwd.get() || currentCwd || undefined).then(
            async resolved => {
              if (!resolved) {
                return
              }

              const trimmedLabel = typeof label === 'string' ? label.trim() : ''
              // The agent's loopback is the GATEWAY's loopback. Give the pane a
              // URL this machine can load, keeping the original as the label so
              // the user still sees the address the agent named.
              const url = resolved.kind === 'url' ? await reachablePreviewUrl(resolved.url) : resolved.url
              const reached = url === resolved.url ? resolved : { ...resolved, label: resolved.label || target, url }

              openPreview(
                renderedHtmlTarget(trimmedLabel ? { ...reached, label: trimmedLabel } : reached),
                ownerStoredSessionId
              )
            }
          )
        }

        return
      }

      if (event.type === 'preview.close') {
        // Agent-driven close via close_preview. Same on-screen gate as open:
        // a session the user can see may tidy the pane it opened; a hidden
        // background turn must not dismiss the user's preview.
        const { url } = asRecord(event.payload)
        const target = typeof url === 'string' ? url.trim() : ''

        if (event.session_id && !sessionIsOnScreen(event.session_id)) {
          return
        }

        // The close acts on the drawer of the session that ASKED — a tile's
        // tidy must reach the tile's own tab, not the focused chat's rail.
        const ownerSessionId = storedIdForEventRuntime(event.session_id) ?? $focusedStoredSessionId.get()

        if (!target) {
          closeRightRail()

          return
        }

        void normalizeOrLocalPreviewTarget(target, $currentCwd.get() || currentCwd || undefined).then(
          async resolved => {
            const candidates = [target]

            if (resolved) {
              candidates.push(resolved.source, resolved.url)

              if (resolved.kind === 'url') {
                candidates.push(await reachablePreviewUrl(resolved.url))
              }
            }

            if (!closeBrowserPreviewMatchingLiveUrl(candidates, ownerSessionId)) {
              closeDockedPreviewMatching(candidates, ownerSessionId)
            }
          }
        )

        return
      }

      if (event.type === 'preview.restart.complete') {
        const { task_id, text } = asRecord(event.payload)

        if (typeof task_id === 'string' && task_id) {
          completePreviewServerRestart(task_id, typeof text === 'string' ? text : '')
        }
      } else if (event.type === 'preview.restart.progress') {
        const { task_id, text } = asRecord(event.payload)

        if (typeof task_id === 'string' && task_id) {
          progressPreviewServerRestart(task_id, typeof text === 'string' ? text : '')
        }
      }

      if (event.session_id && event.session_id !== $focusedRuntimeId.get()) {
        return
      }

      // Only refresh an already-open live preview when a file changes; never
      // open one unprompted. (Preview links are surfaced from the tool row into
      // the status stack — see tool-fallback.tsx.)
      if ($previewTabs.get().some(tab => tab.target.kind === 'url') && gatewayEventCompletedFileDiff(event)) {
        requestPreviewReload()
      }
    },
    [baseHandleGatewayEvent, currentCwd]
  )

  return { handleDesktopGatewayEvent, restartPreviewServer }
}
