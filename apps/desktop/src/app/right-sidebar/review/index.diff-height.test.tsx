import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesReviewFile } from '@/global'
import { I18nProvider } from '@/i18n'
import { $reviewDiff, $reviewDiffLoading, $reviewFiles, $reviewIsRepo, $reviewLoading, $reviewSelectedPath } from '@/store/review'

import { ReviewPane } from './index'

const file = (path: string): HermesReviewFile => ({ added: 1, path, removed: 0, staged: false, status: 'M' })

// A small unified diff: one context line, one add, one remove.
const DIFF = `@@ -1,3 +1,3 @@
 context
-old line
+new line
`

function renderPane() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <ReviewPane />
    </I18nProvider>
  )
}

describe('ReviewPane diff panel height', () => {
  beforeEach(() => {
    $reviewFiles.set([file('a.ts')])
    $reviewIsRepo.set(true)
    $reviewLoading.set(false)
    $reviewDiff.set(DIFF)
    $reviewDiffLoading.set(false)
    $reviewSelectedPath.set('a.ts')

    // jsdom has no layout; give every element a non-zero size so any
    // h-full chain that resolves against a definite parent height shows up.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320)

    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(_callback: ResizeObserverCallback) {}
        disconnect = vi.fn()
        observe = vi.fn()
        unobserve = vi.fn()
      } as unknown as typeof ResizeObserver
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    $reviewFiles.set([])
    $reviewSelectedPath.set(null)
    $reviewDiff.set(null)
  })

  // The virtualized FileDiffPanel renders `absolute inset-0` rows and contributes
  // no intrinsic height, so the container must carry a definite height class —
  // with only `max-h-[55%]` (base) it collapsed to just its 37px header and the
  // diff body resolved h-full → 0.
  it('gives the selected-file diff container a definite height (not just a max)', () => {
    const { container } = renderPane()

    const panel = container.querySelector<HTMLDivElement>('[data-slot="file-diff-panel"]')
    expect(panel).not.toBeNull()

    // panel → flex-1 body → the bordered container that must carry the height
    const wrapper = panel!.parentElement!.parentElement!
    expect(wrapper.className).toContain('h-[55%]')
    expect(wrapper.className).not.toContain('max-h-[55%]')
  })

  it('mounts the diff panel body inside a full-height flex column', () => {
    const { container } = renderPane()

    const body = container.querySelector<HTMLDivElement>('[data-slot="file-diff-panel"]')!.parentElement!
    // The body the panel's h-full resolves against is the flex-1 min-h-0 child
    // of a definite-height flex column.
    expect(body.className).toContain('flex-1')
    expect(body.parentElement!.className).toContain('flex-col')
  })

  // Ordinary case guard: with no file selected the diff container never mounts,
  // so the tree keeps the full pane and nothing else changed.
  it('renders no diff container when no file is selected', () => {
    $reviewSelectedPath.set(null)
    $reviewDiff.set(null)

    const { container } = renderPane()

    expect(container.querySelector('[data-slot="file-diff-panel"]')).toBeNull()
  })
})
