import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  $previewTabs,
  $visiblePreviewTabs,
  decodePreviewTabs,
  newBrowserTab,
  openPreview,
  type PreviewTarget,
  rekeyPreviewTabsForSession
} from './preview'
import { $selectedStoredSessionId } from './session'

// Regression coverage for the four flows that reverted the session-scoped
// rail (https://github.com/NousResearch/hermes-agent/pull/130852). Each test
// works at the store + persistence seam: the row is written by the real store,
// read back through the real encoder/decoder, and only then asserted on.

function urlTarget(source: string): PreviewTarget {
  return { kind: 'url', label: source, source, url: source }
}

function fileTarget(source: string): PreviewTarget {
  return { kind: 'file', label: source, path: source, previewKind: 'html', source, url: `file://${source}` }
}

/** The single profile bucket the store persists, as written. */
function persistedBucket(): unknown[] {
  const raw = window.localStorage.getItem('hermes.desktop.previewTabs.v2') ?? '{}'
  const buckets = JSON.parse(raw) as Record<string, unknown[]>

  return Object.values(buckets)[0] ?? []
}

describe('preview tabs regressions (#73890 re-land)', () => {
  beforeEach(() => {
    $selectedStoredSessionId.set(null)
    $previewTabs.set([])
    window.localStorage.clear()
  })

  afterEach(() => {
    $selectedStoredSessionId.set(null)
    $previewTabs.set([])
    window.localStorage.clear()
  })

  // Regression 1: the strip's "+" Browser tab carried no owning session, so it
  // stayed invisible, and the ownerless-adoption listener claimed it for the
  // session that focused NEXT — the wrong session on a switch.
  it('stamps the opening session on a "+" Browser tab, so it is visible at once and never re-adopted', () => {
    $selectedStoredSessionId.set('sess-1')

    newBrowserTab()

    expect($previewTabs.get()).toHaveLength(1)
    expect($previewTabs.get()[0]).toMatchObject({ sessionId: 'sess-1' })
    expect($visiblePreviewTabs.get()).toHaveLength(1)

    // The row round-trips through the real encoder/decoder with its owner.
    const restored = decodePreviewTabs(JSON.stringify(persistedBucket()))
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ sessionId: 'sess-1' })

    // Switching sessions must not adopt the tab into the next session: it
    // stays owned by (and hidden outside) the session that clicked "+".
    $selectedStoredSessionId.set('sess-2')

    expect($previewTabs.get()[0]?.sessionId).toBe('sess-1')
    expect($visiblePreviewTabs.get()).toHaveLength(0)

    $selectedStoredSessionId.set('sess-1')

    expect($visiblePreviewTabs.get()).toHaveLength(1)
  })

  // Regression 2 (reported by DavidMetcalfe with this repro on the original
  // PR): parseTabList's `lastUrl` skip dropped every Browser row but the last
  // on restore — 3 live, 3 persisted, 1 restored — and pop-out, which looks a
  // tab up by its persisted id, lost its backing row whenever the popped
  // Browser was not the newest URL row.
  it('restores every Browser tab with its minted id, not just the newest', () => {
    $selectedStoredSessionId.set('sess-1')

    // The strip's "+" mints the surface; openPreview navigates the ACTIVE
    // Browser, so each round leaves another Browser holding its own page.
    newBrowserTab()
    openPreview(urlTarget('https://a.example'))
    newBrowserTab()
    openPreview(urlTarget('https://b.example'))
    newBrowserTab()
    openPreview(urlTarget('https://c.example'))

    const live = $previewTabs.get().filter(tab => tab.target.kind === 'url')
    expect(live).toHaveLength(3)

    // Rows written by the store, then read back through the same decoder a
    // relaunch runs (loadTabsByProfile → parseTabList).
    const restored = decodePreviewTabs(JSON.stringify(persistedBucket()))

    expect(restored).toHaveLength(3)
    // Minted ids survive verbatim — the pop-out hand-off depends on them.
    expect(restored.map(tab => tab.id)).toEqual(live.map(tab => tab.id))
    expect(restored.map(tab => tab.target.url)).toEqual(['https://a.example', 'https://b.example', 'https://c.example'])
  })

  // Regression 4: auto-compression mints a new stored session id; tabs owned
  // by the old tip vanished from the drawer once the rail started naming the
  // new tip. Ownership must follow the lineage rotation.
  it('keeps a session tabs across a compression id rotation', () => {
    $selectedStoredSessionId.set('tip-old')
    openPreview(fileTarget('/work/report.html'))
    newBrowserTab()
    openPreview(urlTarget('https://b.example'))

    // Pin another session's tab to prove the rotation leaves it alone.
    $previewTabs.set([
      ...$previewTabs.get(),
      { id: 'file:/work/pinned.html', target: fileTarget('/work/pinned.html'), sessionId: 'other', pinned: true }
    ])

    // The rotation the compression edges publish (session-states rekeys the
    // tile on exactly this pair).
    rekeyPreviewTabsForSession('tip-old', 'tip-new')

    // File id rekeys onto the new owner; the minted Browser id is kept
    // verbatim; the other session's pinned row is untouched.
    expect($previewTabs.get().map(tab => [tab.id, tab.sessionId, tab.pinned])).toEqual([
      ['file:tip-new:/work/report.html', 'tip-new', undefined],
      [expect.stringMatching(/^url:browser-/), 'tip-new', undefined],
      ['file:/work/pinned.html', 'other', true]
    ])

    // The drawer survives the rotation end to end: rows written by the store
    // come back through the real decoder owned by the new tip.
    $selectedStoredSessionId.set('tip-new')
    expect($visiblePreviewTabs.get()).toHaveLength(3)

    const restored = decodePreviewTabs(JSON.stringify(persistedBucket()))
    expect(restored).toHaveLength(3)
    expect(restored.every(tab => tab.pinned || tab.sessionId === 'tip-new')).toBe(true)
  })
})
