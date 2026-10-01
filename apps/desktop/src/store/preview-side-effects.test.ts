// Side-effect screen probes (not part of the test suite run gates): each
// writes rows the way MAIN'S build would have (unscoped), or the way this
// build does, then round-trips through the real persist/decode seam and
// asserts the visible outcome. Run: npx vitest run src/store/preview-side-effects.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $previewTabs, $visiblePreviewTabs, decodePreviewTabs, openPreview, type PreviewTarget } from './preview'
import { $selectedStoredSessionId } from './session'

const TABS_KEY = 'hermes.desktop.previewTabs.v2'

function fileTarget(source: string): PreviewTarget {
  return { kind: 'file', label: source, path: source, previewKind: 'html', source, url: `file://${source}` }
}

function urlTarget(source: string): PreviewTarget {
  return { kind: 'url', label: source, source, url: source }
}

/** Write rows exactly the way main's pre-scope build persisted them: raw
 *  bucket-of-arrays with unprefixed file ids and no session/pin fields. */
function writeMainLegacyBucket(rows: unknown[]): void {
  window.localStorage.setItem(TABS_KEY, JSON.stringify({ default: rows }))
}

describe('preview tabs side-effect probes', () => {
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

  it('existing state: unscoped rows written by main restore into a sensible owner', () => {
    // What main (unscoped) persists: two files, two Browsers, no session ids.
    writeMainLegacyBucket([
      { id: 'file:/work/a.html', target: fileTarget('/work/a.html') },
      { id: 'file:/work/b.html', target: fileTarget('/work/b.html') },
      { id: 'url:https://x.example', target: urlTarget('https://x.example') },
      { id: 'url:https://y.example', target: urlTarget('https://y.example') }
    ])

    // What a relaunch of THIS build runs: loadTabsByProfile → parseTabList,
    // over the raw single-bucket record (decode takes the ROW list, exactly
    // what loadTabsByProfile hands it per profile).
    const record = JSON.parse(window.localStorage.getItem(TABS_KEY) ?? '{}') as Record<string, unknown[]>
    const restored = decodePreviewTabs(JSON.stringify(record['default'] ?? []))

    // Not vanished, not collapsed: every row survives.
    expect(restored).toHaveLength(4)

    // And they do not all land in one session: legacy rows migrate to
    // workspace-pinned, so every session's drawer shows them (the explicit
    // cross-session escape hatch) until the user unpins.
    expect(restored.every(tab => tab.pinned === true)).toBe(true)
    expect(restored.map(tab => tab.id)).toEqual([
      'file:/work/a.html',
      'file:/work/b.html',
      'url:https://x.example',
      'url:https://y.example'
    ])
  })

  it('existing state: rows persisted by a session-scoped build restore into their owners', () => {
    const rows = [
      { id: 'file:sess-1:/work/a.html', target: fileTarget('/work/a.html'), sessionId: 'sess-1' },
      { id: 'file:sess-2:/work/b.html', target: fileTarget('/work/b.html'), sessionId: 'sess-2' },
      { id: 'url:browser-abc', target: urlTarget('https://z.example'), sessionId: 'sess-1' }
    ]

    writeMainLegacyBucket(rows)

    const restored = decodePreviewTabs(JSON.stringify(rows))

    expect(restored).toHaveLength(3)
    expect(restored[0]).toMatchObject({ id: 'file:sess-1:/work/a.html', sessionId: 'sess-1' })
    expect(restored[1]).toMatchObject({ id: 'file:sess-2:/work/b.html', sessionId: 'sess-2' })
    // Browser rows keep their minted id verbatim.
    expect(restored[2]).toMatchObject({ id: 'url:browser-abc', sessionId: 'sess-1' })

    // Each drawer sees exactly its own rows after restore.
    $previewTabs.set(restored)
    $selectedStoredSessionId.set('sess-1')
    expect($visiblePreviewTabs.get()).toHaveLength(2)
    $selectedStoredSessionId.set('sess-2')
    expect($visiblePreviewTabs.get()).toHaveLength(1)
  })

  it('restart round-trip: rows written by this build relaunch into the same drawers', () => {
    $selectedStoredSessionId.set('sess-1')
    openPreview(fileTarget('/work/one.html'))
    $selectedStoredSessionId.set('sess-2')
    openPreview(fileTarget('/work/two.html'))

    // The real key, as this build wrote it.
    const raw = window.localStorage.getItem(TABS_KEY) ?? ''
    const buckets = JSON.parse(raw) as Record<string, unknown[]>
    const rows = buckets['default'] ?? []

    // A "relaunch": decode what was written.
    const restored = decodePreviewTabs(JSON.stringify(rows))
    $previewTabs.set(restored)

    expect($previewTabs.get()).toHaveLength(2)
    $selectedStoredSessionId.set('sess-1')
    expect($visiblePreviewTabs.get().map(tab => tab.target.path)).toEqual(['/work/one.html'])
    $selectedStoredSessionId.set('sess-2')
    expect($visiblePreviewTabs.get().map(tab => tab.target.path)).toEqual(['/work/two.html'])
  })
})
