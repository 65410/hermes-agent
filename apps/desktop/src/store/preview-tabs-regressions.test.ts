import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $previewTabs, $visiblePreviewTabs, decodePreviewTabs, newBrowserTab } from './preview'
import { $selectedStoredSessionId } from './session'

// Regression coverage for the four flows that reverted the session-scoped
// rail (https://github.com/NousResearch/hermes-agent/pull/130852). Each test
// works at the store + persistence seam: the row is written by the real store,
// read back through the real encoder/decoder, and only then asserted on.

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
})
