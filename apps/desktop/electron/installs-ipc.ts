/**
 * installs-ipc.ts
 *
 * Electron IPC for the desktop `hermes installs` UI. Three channels mirror
 * the CLI subcommands:
 *   - `hermes:installs:list`    → `hermes installs list --json`
 *   - `hermes:installs:remove`  → `hermes installs remove <id> --yes`
 *   - `hermes:installs:dismiss` → `hermes installs dismiss`
 *
 * The handler never builds a shell string: it validates the id against a
 * strict pattern (installs-cli.ts), builds an argv array, and hands it to the
 * injected runner. main.ts supplies the venv python spawn, so `current` is the
 * install the desktop app is running from — the same backend the uninstaller
 * uses for `hermes uninstall --gui-summary`.
 *
 * The boot notice lives here too: it runs the list once, decides from the pure
 * predicate, and sends one notice to the renderer. It latches so it shows at
 * most once per app launch. Failures are swallowed with a debug log.
 */

import {
  dismissArgs,
  type InstallsListResult,
  listArgs,
  parseInstallsList,
  removeArgs,
  shouldShowBootNotice
} from './installs-cli'

export interface InstallsRunOutcome {
  code: null | number
  stdout: string
  stderr: string
}

export interface InstallsRemoveResult {
  ok: boolean
  error?: string
  message?: string
}

export interface InstallsIpcDeps {
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) => void
  }
  /** Spawn `python -m hermes_cli.main <args…>` through the backend python. */
  runInstalls: (args: string[]) => Promise<InstallsRunOutcome>
  /** Debug sink for swallowed failures (desktop.log). */
  logDebug: (message: string) => void
}

export function registerInstallsIpc({ ipcMain, runInstalls, logDebug }: InstallsIpcDeps): void {
  ipcMain.handle('hermes:installs:list', async (): Promise<null | InstallsListResult> => {
    try {
      const outcome = await runInstalls(listArgs())

      if (outcome.code !== 0) {
        return null
      }

      return parseInstallsList(outcome.stdout)
    } catch (error) {
      logDebug(`[installs] list failed: ${error instanceof Error ? error.message : String(error)}`)

      return null
    }
  })

  ipcMain.handle(
    'hermes:installs:remove',
    async (_event: unknown, payload?: unknown): Promise<InstallsRemoveResult> => {
      const rawId = payload && typeof payload === 'object' && 'id' in payload ? (payload as any).id : payload
      const args = removeArgs(rawId)

      if (!args) {
        return { ok: false, error: 'invalid-id', message: `Not a valid install id: ${String(rawId ?? '')}` }
      }

      try {
        const outcome = await runInstalls(args)

        if (outcome.code !== 0) {
          const detail = outcome.stderr.trim() || outcome.stdout.trim() || `exit code ${String(outcome.code)}`

          return { ok: false, error: 'remove-failed', message: detail }
        }

        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logDebug(`[installs] remove failed: ${message}`)

        return { ok: false, error: 'spawn-failed', message }
      }
    }
  )

  ipcMain.handle('hermes:installs:dismiss', async (): Promise<{ ok: boolean }> => {
    try {
      const outcome = await runInstalls(dismissArgs())

      return { ok: outcome.code === 0 }
    } catch (error) {
      logDebug(`[installs] dismiss failed: ${error instanceof Error ? error.message : String(error)}`)

      return { ok: false }
    }
  })
}

export interface InstallsNoticePayload {
  /** Other installs the user can remove from the Settings page. */
  count: number
}

export interface InstallsNoticeDeps {
  runInstalls: (args: string[]) => Promise<InstallsRunOutcome>
  sendNotice: (payload: InstallsNoticePayload) => void
  logDebug: (message: string) => void
}

let installsNoticeShown = false

/** Test hook: a fresh app launch forgets the once-per-launch latch. */
export function resetInstallsNoticeLatchForTests(): void {
  installsNoticeShown = false
}

/**
 * One background boot check: list once after the backend is ready and, when
 * other installs exist and the user has not dismissed the notice, send one
 * event to the renderer. Latched, so each app launch shows it at most once.
 * Never delays startup: the caller fires this without awaiting.
 */
export function runInstallsNoticeCheck({ runInstalls, sendNotice, logDebug }: InstallsNoticeDeps): void {
  if (installsNoticeShown) {
    return
  }

  void runInstalls(listArgs())
    .then(outcome => {
      if (outcome.code !== 0) {
        logDebug(`[installs] boot notice list exited ${String(outcome.code)}`)

        return
      }

      const list = parseInstallsList(outcome.stdout)

      if (!shouldShowBootNotice(list)) {
        return
      }

      installsNoticeShown = true
      sendNotice({ count: list!.notice.count })
    })
    .catch((error: unknown) => {
      logDebug(`[installs] boot notice check failed: ${error instanceof Error ? error.message : String(error)}`)
    })
}
