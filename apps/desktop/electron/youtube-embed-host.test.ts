/**
 * The YouTube embed host is a loopback listener the chat frames to give the
 * player a real http origin. It must serve only a page for a well-formed
 * video id, never block startup when it cannot bind, and leave no listener
 * behind after quit. Real ephemeral listener; electron mocked.
 */

import http from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, () => Promise<null | string>>()
const quitListeners: Array<() => void> = []

vi.mock('electron', () => ({
  app: { on: (event: string, fn: () => void) => event === 'will-quit' && quitListeners.push(fn) },
  ipcMain: { handle: (channel: string, fn: () => Promise<null | string>) => handlers.set(channel, fn) }
}))

const { installYouTubeEmbedHost } = await import('./youtube-embed-host')

function install() {
  handlers.clear()
  quitListeners.length = 0
  installYouTubeEmbedHost(() => {})

  return handlers.get('hermes:youtube-embed:origin')!
}

afterEach(() => {
  quitListeners.forEach(quit => quit())
  vi.restoreAllMocks()
})

describe('YouTube embed host', () => {
  it('serves a player page with a matching origin only for well-formed video ids', async () => {
    const origin = await install()()

    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const page = await fetch(`${origin}/youtube-embed/jNQXAC9IVRw?start=42`)
    const html = await page.text()

    expect(page.status).toBe(200)
    const src = new URL(html.match(/src="([^"]+)"/)![1].replaceAll('&amp;', '&'))
    expect(src.origin).toBe('https://www.youtube-nocookie.com')
    expect(src.pathname).toBe('/embed/jNQXAC9IVRw')
    expect(src.searchParams.get('origin')).toBe(origin)
    expect(src.searchParams.get('start')).toBe('42')

    const rejected = [
      '/',
      '/youtube-embed/',
      '/youtube-embed/short',
      '/youtube-embed/jNQXAC9IVRwX',
      '/youtube-embed/jNQXAC9IVRw/extra',
      '/youtube-embed/..%2F..%2Fetc%2Fpasswd',
      '/youtube-embed/%3Cscript%3E1',
      '/youtube-embed/../index.html',
      '/https://evil.example/',
      '/favicon.ico'
    ]

    for (const path of rejected) {
      expect((await fetch(`${origin}${path}`)).status, path).toBe(404)
    }

    expect((await fetch(`${origin}/youtube-embed/jNQXAC9IVRw`, { method: 'POST' })).status).toBe(404)

    const injected = await (await fetch(`${origin}/youtube-embed/jNQXAC9IVRw?start=1"><script>`)).text()
    expect(injected).not.toContain('<script')
  })

  it('degrades to null when the listener cannot bind and closes on quit', async () => {
    vi.spyOn(http.Server.prototype, 'listen').mockImplementationOnce(function (this: http.Server) {
      queueMicrotask(() => this.emit('error', Object.assign(new Error('bind'), { code: 'EADDRNOTAVAIL' })))

      return this
    })

    await expect(install()()).resolves.toBeNull()

    vi.restoreAllMocks()
    const origin = await install()()
    await fetch(`${origin}/youtube-embed/jNQXAC9IVRw`)
    quitListeners.forEach(quit => quit())

    await expect(fetch(`${origin}/youtube-embed/jNQXAC9IVRw`)).rejects.toThrow()
  })
})
