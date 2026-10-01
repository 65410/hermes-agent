import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { detectEmbed } from './providers'
import type { FrameEmbed } from './providers/types'
import YouTubeEmbedRenderer from './youtube-embed'

const descriptor = detectEmbed('https://www.youtube.com/watch?v=jNQXAC9IVRw&t=42') as FrameEmbed

function withHost(origin: null | string) {
  Object.assign(window, { hermesDesktop: { youtubeEmbedOrigin: vi.fn(async () => origin) } })
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('YouTubeEmbedRenderer in the desktop app', () => {
  // A file:// document cannot embed the player (error 153); the frame must
  // go through the loopback host, never straight to YouTube.
  it('frames the loopback host page instead of YouTube', async () => {
    withHost('http://127.0.0.1:43210')
    const { container } = render(<YouTubeEmbedRenderer descriptor={descriptor} />)

    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const src = new URL(container.querySelector('iframe')!.src)

    expect(src.origin).toBe('http://127.0.0.1:43210')
    expect(src.pathname).toBe('/youtube-embed/jNQXAC9IVRw')
    expect(src.searchParams.get('start')).toBe('42')
  })

  it('degrades to a plain link when the host is unavailable', async () => {
    withHost(null)
    const { container } = render(<YouTubeEmbedRenderer descriptor={descriptor} />)

    await waitFor(() => expect(container.querySelector('a')).not.toBeNull())
    expect(container.querySelector('a')!.getAttribute('href')).toContain('jNQXAC9IVRw')
    expect(container.querySelector('iframe')).toBeNull()
  })
})
