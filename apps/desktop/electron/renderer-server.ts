import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

const DEFAULT_PORT = 47891

// A script-free document on the renderer origin. The storage migration loads it
// to write localStorage under this origin without booting the app.
const BLANK_PATH = '/__hermes/blank.html'

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

interface RendererServer {
  close: () => Promise<void>
  origin: string
}

function rendererRequestPath(root: string, requestUrl: string): string | null {
  let pathname

  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://127.0.0.1').pathname)
  } catch {
    return null
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = path.resolve(root, relative)

  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return null
  }

  return target
}

function listenOnce(server: http.Server, port: number): Promise<AddressInfo> {
  return new Promise<AddressInfo>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('error', onError)
      reject(error)
    }

    server.once('error', onError)
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.removeListener('error', onError)
      resolve(server.address() as AddressInfo)
    })
  })
}

// Bind failures that another free port would resolve. EADDRINUSE is the common
// one (a second Hermes instance, or any unrelated listener); EACCES shows up on
// Windows when a port sits in an excluded/reserved range.
function isPortCollision(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code

  return code === 'EADDRINUSE' || code === 'EACCES'
}

async function startRendererServer(
  rootDir: string,
  { port = DEFAULT_PORT }: { port?: number } = {}
): Promise<RendererServer> {
  const root = path.resolve(rootDir)
  const indexPath = path.join(root, 'index.html')

  const server = http.createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end()

      return
    }

    if (request.url === BLANK_PATH) {
      response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': MIME_TYPES['.html'] })
      response.end(request.method === 'HEAD' ? undefined : '<!doctype html>')

      return
    }

    const requested = rendererRequestPath(root, request.url || '/')

    if (!requested) {
      response.writeHead(400)
      response.end()

      return
    }

    let filePath = requested

    try {
      const stat = await fs.promises.stat(filePath)

      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html')
      }
    } catch {
      // HashRouter routes never reach the server, but an extensionless reload
      // should still receive the SPA shell.
      filePath = path.extname(filePath) ? filePath : indexPath
    }

    try {
      const body = await fs.promises.readFile(filePath)
      const extension = path.extname(filePath).toLowerCase()
      const isIndex = filePath === indexPath
      response.writeHead(200, {
        'Cache-Control': isIndex ? 'no-store' : 'public, max-age=31536000, immutable',
        'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff'
      })
      response.end(request.method === 'HEAD' ? undefined : body)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })

  // Prefer a stable port: the renderer's origin keys its localStorage /
  // sessionStorage, so a port that changed between launches would silently orphan
  // persisted renderer state. A taken port tries a few fixed neighbours first, so
  // a squatter costs one migration, not settings on every launch. It must never
  // block startup — main.ts awaits this before createWindow(), so rejecting here
  // means no window at all — so the last resort is an OS-assigned ephemeral port.
  const candidates = port === 0 ? [0] : [port, port + 1, port + 2, port + 3, 0]
  let address: AddressInfo | undefined

  for (const candidate of candidates) {
    try {
      address = await listenOnce(server, candidate)

      break
    } catch (error) {
      if (candidate === 0 || !isPortCollision(error)) {
        throw error
      }
    }
  }

  return {
    close: () => new Promise<void>(done => server.close(() => done())),
    origin: `http://127.0.0.1:${address!.port}`
  }
}

/**
 * The renderer port for this install's userData. The default data dir keeps
 * DEFAULT_PORT; a second instance (HERMES_DATA_DIR_SUFFIX or a custom data dir)
 * runs alongside it, so it gets its own stable port derived from the path rather
 * than losing the collision and landing on a new origin every launch.
 */
function rendererPortFor(userData: string, isDefaultUserData: boolean): number {
  if (isDefaultUserData) {
    return DEFAULT_PORT
  }

  let hash = 0x811c9dc5

  for (const char of userData) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193)
  }

  return DEFAULT_PORT + 10 + ((hash >>> 0) % 1000) * 4
}

export { BLANK_PATH, DEFAULT_PORT, rendererPortFor, rendererRequestPath, startRendererServer }
export type { RendererServer }
