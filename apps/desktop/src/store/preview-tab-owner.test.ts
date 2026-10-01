// #73890: preview tabs leaked across sessions. A tab is now stamped with the
// STORED id of the session that opened it, and the rail renders a row only
// while its owner is on screen (the primary selection or an open tile).
// Rows written before the field existed (main's rows) have no owner and stay
// visible everywhere — and their ids, like every id here, never change.
//
// These tests drive the real seam: session-states pushes the visible set and
// the focused owner into the store exactly as the app wires it, compression
// rekeys the owner field through the same transition the session tiles use,
// and persistence round-trips through `hermes.desktop.previewTabs.v2`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClientSessionState } from '@/lib/chat-runtime'

import { $selectedStoredSessionId } from './session'
import { $sessionTiles, publishSessionState } from './session-states'

const TABS_KEY = 'hermes.desktop.previewTabs.v2'

interface StoredRow {
  id: string
  sessionId?: string
  target: { kind: string; label: string; source: string; url: string }
}

function fileTarget(path: string) {
  return { kind: 'file' as const, label: path, path, previewKind: 'html' as const, source: path, url: `file://${path}` }
}

function urlTarget(url: string) {
  return { kind: 'url' as const, label: url, source: url, url }
}

function storedRows(): StoredRow[] {
  const raw = window.localStorage.getItem(TABS_KEY)

  if (!raw) {
    return []
  }

  const parsed = JSON.parse(raw) as Record<string, StoredRow[]>

  return Object.values(parsed).flat()
}

async function freshPreview() {
  const preview = await import('./preview')

  return preview
}

describe('preview tabs are owned by the session that opened them', () => {
  beforeEach(async () => {
    window.localStorage.clear()
    $sessionTiles.set([])
    $selectedStoredSessionId.set(null)

    const { closeRightRail } = await freshPreview()

    closeRightRail()
  })

  afterEach(() => {
    window.localStorage.clear()
    $sessionTiles.set([])
    $selectedStoredSessionId.set(null)
  })

  it('hides session A’s tab while session B is on screen, keeping it alive with the same id', async () => {
    const { $previewTabs, $previewTarget, $visiblePreviewTabs, openPreview } = await freshPreview()

    $selectedStoredSessionId.set('stored-a')
    openPreview(fileTarget('/work/mockup.html'))

    const row = $visiblePreviewTabs.get()[0]

    expect(row.id).toBe('file:file:///work/mockup.html')
    expect(row.sessionId).toBe('stored-a')
    expect($previewTarget.get()?.path).toBe('/work/mockup.html')

    // Reading session B hides A’s tab — the leak.
    $selectedStoredSessionId.set('stored-b')

    expect($visiblePreviewTabs.get()).toEqual([])
    expect($previewTarget.get()).toBeNull()

    // Hidden, not closed: the row and its id survive in the store and storage.
    expect($previewTabs.get().map(tab => tab.id)).toEqual(['file:file:///work/mockup.html'])

    const persisted = storedRows()

    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ id: 'file:file:///work/mockup.html', sessionId: 'stored-a' })

    // Back on A, the same row (same id) is showing again.
    $selectedStoredSessionId.set('stored-a')

    expect($visiblePreviewTabs.get().map(tab => tab.id)).toEqual(['file:file:///work/mockup.html'])
    expect($previewTarget.get()?.path).toBe('/work/mockup.html')
  })

  it('owns the strip’s "+" Browser tab by the focused session', async () => {
    const { $visiblePreviewTabs, newBrowserTab } = await freshPreview()

    $selectedStoredSessionId.set('stored-a')
    newBrowserTab()

    expect($visiblePreviewTabs.get()).toHaveLength(1)
    expect($visiblePreviewTabs.get()[0].sessionId).toBe('stored-a')

    // Session B sees neither A’s Browser nor a leak — and its own "+" is B’s.
    $selectedStoredSessionId.set('stored-b')

    expect($visiblePreviewTabs.get()).toEqual([])

    newBrowserTab()

    expect($visiblePreviewTabs.get()).toHaveLength(1)
    expect($visiblePreviewTabs.get()[0].sessionId).toBe('stored-b')
  })

  it('gives the second session its own row for the same file, without rekeying the first', async () => {
    const { $previewTabs, $visiblePreviewTabs, openPreview } = await freshPreview()

    $selectedStoredSessionId.set('stored-a')
    openPreview(fileTarget('/work/shared.html'))

    const firstId = 'file:file:///work/shared.html'

    expect($previewTabs.get().map(tab => tab.id)).toEqual([firstId])

    // The same file opened by session B: one row per (session, file). The
    // existing row keeps main's exact id; only the NEW row gets a variant.
    $selectedStoredSessionId.set('stored-b')
    openPreview(fileTarget('/work/shared.html'))

    const rows = $previewTabs.get()

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: firstId, sessionId: 'stored-a' })
    expect(rows[1]).toMatchObject({ id: `${firstId}~2`, sessionId: 'stored-b' })

    // Each session sees exactly its own row.
    expect($visiblePreviewTabs.get().map(tab => tab.id)).toEqual([`${firstId}~2`])

    $selectedStoredSessionId.set('stored-a')

    expect($visiblePreviewTabs.get().map(tab => tab.id)).toEqual([firstId])

    // Re-opening in A refreshes A’s row; no third row, no rekey.
    openPreview({ ...fileTarget('/work/shared.html'), label: 'renamed' })

    expect($previewTabs.get()).toHaveLength(2)
    expect($previewTabs.get()[0]).toMatchObject({ id: firstId, sessionId: 'stored-a' })
    expect($previewTabs.get()[0].target.label).toBe('renamed')
  })

  it('keeps a session’s tabs visible through auto-compression’s id rotation', async () => {
    const { $previewTabs, $visiblePreviewTabs, openPreview } = await freshPreview()

    $selectedStoredSessionId.set('stored-a')
    openPreview(fileTarget('/work/report.html'))

    const id = 'file:file:///work/report.html'

    expect($previewTabs.get()[0].id).toBe(id)

    // Auto-compression replaces the conversation's stored id with its
    // continuation — the same transition the session tiles rekey on.
    publishSessionState('rt-1', { ...createClientSessionState('stored-a'), busy: true })
    publishSessionState('rt-1', { ...createClientSessionState('stored-a2'), busy: false })

    // The tab id NEVER changes; only the owner field follows the rotation.
    expect($previewTabs.get()[0].id).toBe(id)
    expect($previewTabs.get()[0].sessionId).toBe('stored-a2')

    // The continuation is on screen; the tab is still visible there.
    $selectedStoredSessionId.set('stored-a2')

    expect($visiblePreviewTabs.get().map(tab => tab.id)).toEqual([id])

    const persisted = storedRows()

    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ id, sessionId: 'stored-a2' })
  })

  it('scopes a Browser to its session: B’s link opens B’s vessel, not A’s', async () => {
    const { $previewTabs, $visiblePreviewTabs, openPreview } = await freshPreview()

    $selectedStoredSessionId.set('stored-a')
    openPreview(urlTarget('https://a.example/start'))
    const aBrowser = $previewTabs.get()[0]

    expect(aBrowser.sessionId).toBe('stored-a')

    $selectedStoredSessionId.set('stored-b')
    openPreview(urlTarget('https://b.example/'))

    // B gets its own Browser; A’s is untouched and hidden in B.
    const rows = $previewTabs.get()

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: aBrowser.id, sessionId: 'stored-a' })
    expect(rows[0].target.url).toBe('https://a.example/start')
    expect(rows[1].sessionId).toBe('stored-b')
    expect(rows[1].target.url).toBe('https://b.example/')
    expect($visiblePreviewTabs.get().map(tab => tab.id)).toEqual([rows[1].id])
  })
})

describe('preview tab persistence round-trip', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
    $sessionTiles.set([])
    $selectedStoredSessionId.set(null)
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it('loads rows written by main (no owner) unchanged, and keeps them visible everywhere', async () => {
    // Exactly the shape main writes today: no sessionId key at all.
    window.localStorage.setItem(
      TABS_KEY,
      JSON.stringify({
        default: [{ id: 'file:file:///work/legacy.html', target: fileTarget('/work/legacy.html') }]
      })
    )

    const { $previewTabs, $visiblePreviewTabs, setPreviewSessionScope } = await freshPreview()

    expect($previewTabs.get()).toHaveLength(1)

    const row = $previewTabs.get()[0]

    expect(row.id).toBe('file:file:///work/legacy.html')
    expect(row.sessionId).toBeUndefined()

    // No session on screen: a main-written row is still shown.
    expect($visiblePreviewTabs.get().map(tab => tab.id)).toEqual(['file:file:///work/legacy.html'])

    // Another session on screen: still shown — unowned rows are global.
    setPreviewSessionScope('stored-b', ['stored-b'])

    expect($visiblePreviewTabs.get().map(tab => tab.id)).toEqual(['file:file:///work/legacy.html'])
  })

  it('restores three Browser rows with the same ids and pop-out lookup still finds them', async () => {
    const rows = [
      { id: 'url:browser-one', sessionId: 'stored-a', target: urlTarget('https://a.example') },
      { id: 'url:browser-two', sessionId: 'stored-a', target: urlTarget('https://b.example') },
      { id: 'url:browser-three', sessionId: 'stored-b', target: urlTarget('https://c.example') }
    ]

    window.localStorage.setItem(TABS_KEY, JSON.stringify({ tess: rows }))

    const { $previewTabs, adoptPersistedBrowserTab } = await freshPreview()

    // A fresh pop-out renderer starts on the default (empty) view and pulls
    // its tab in by persisted id — the exact lookup pop-out runs on restore.
    adoptPersistedBrowserTab('url:browser-two')

    const restored = $previewTabs.get()

    expect(restored.map(tab => tab.id)).toEqual(['url:browser-one', 'url:browser-two', 'url:browser-three'])
    expect(restored[1].sessionId).toBe('stored-a')
    expect(restored[1].target.url).toBe('https://b.example')
  })
})
