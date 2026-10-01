/**
 * Loopback host page for YouTube embeds (#106596).
 *
 * The packaged renderer is a file:// document, so an iframe it points at
 * youtube-nocookie.com carries no Referer and YouTube refuses to configure the
 * player (error 153). Rewriting Referer in webRequest is dropped by modern
 * Electron (electron/electron#21374), and moving the whole renderer onto an
 * http origin broke remote-backend WebSocket origin checks and every
 * per-origin renderer setting (#130852). So only the embed gets an http
 * origin: the chat frames http://127.0.0.1:<ephemeral>/youtube-embed/<id>,
 * whose page frames the player with a matching `origin` param. YouTube then
 * sees Referer + origin = that loopback origin.
 *
 * The server starts lazily on the first embed that needs it (so it can never
 * delay or abort app startup), binds 127.0.0.1 only on an ephemeral port, and
 * serves nothing but a static page for a well-formed video id: no proxying,
 * no files, every other request is 404. A bind failure resolves to null and
 * the renderer degrades that embed to a plain link.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { app, ipcMain } from 'electron'

const EMBED_PATH_RE = /^\/youtube-embed\/([A-Za-z0-9_-]{11})$/
const START_RE = /^\d{1,6}$/

const PLAYER_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen'

const PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; frame-src https://www.youtube-nocookie.com; style-src 'unsafe-inline'",
  'Content-Type': 'text/html; charset=utf-8',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff'
}

/** The host page for `requestUrl`, or null when it is not a well-formed embed request. */
function youtubeEmbedHostPage(requestUrl: string, origin: string): null | string {
  const url = new URL(requestUrl, origin)
  const id = EMBED_PATH_RE.exec(url.pathname)?.[1]

  if (!id) {
    return null
  }

  const player = new URL(`https://www.youtube-nocookie.com/embed/${id}`)
  player.searchParams.set('modestbranding', '1')
  player.searchParams.set('rel', '0')
  player.searchParams.set('origin', origin)

  const start = url.searchParams.get('start')

  if (start && START_RE.test(start)) {
    player.searchParams.set('start', start)
  }

  // Every interpolated value is built from the validated id, digits, and our
  // own origin, so the markup needs no escaping beyond URL serialization.
  return (
    '<!doctype html><meta charset="utf-8"><title>YouTube</title>' +
    '<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}' +
    'iframe{display:block;border:0;width:100%;height:100%}</style>' +
    `<iframe allow="${PLAYER_ALLOW}" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" ` +
    `src="${player.toString().replaceAll('&', '&amp;')}" title="YouTube embed"></iframe>`
  )
}

/**
 * Answer `hermes:youtube-embed:origin` with the loopback host's origin (null
 * when it cannot bind) and close the listener when the app quits.
 */
export function installYouTubeEmbedHost(log: (message: string) => void): void {
  let server: http.Server | null = null
  let starting: Promise<null | string> | null = null

  const start = () =>
    new Promise<null | string>(resolve => {
      const candidate = http.createServer((req, res) => {
        const origin = `http://127.0.0.1:${(candidate.address() as AddressInfo).port}`
        const page = req.method === 'GET' || req.method === 'HEAD' ? youtubeEmbedHostPage(req.url || '/', origin) : null

        if (page === null) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')

          return
        }

        res.writeHead(200, PAGE_HEADERS).end(req.method === 'HEAD' ? undefined : page)
      })

      candidate.on('error', (error: NodeJS.ErrnoException) => {
        log(`[youtube-embed] loopback host unavailable (${error.code || error.message}); embeds fall back to links`)
        resolve(null)
      })
      candidate.listen({ host: '127.0.0.1', port: 0 }, () => {
        server = candidate
        resolve(`http://127.0.0.1:${(candidate.address() as AddressInfo).port}`)
      })
    })

  ipcMain.handle('hermes:youtube-embed:origin', () => (starting ??= start()))
  app.on('will-quit', () => {
    server?.closeAllConnections()
    server?.close()
    server = null
  })
}
