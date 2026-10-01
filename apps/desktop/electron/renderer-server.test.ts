import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

const nodeRequire = createRequire(import.meta.url)

const { BLANK_PATH, DEFAULT_PORT, rendererPortFor, rendererRequestPath, startRendererServer } =
  nodeRequire('./renderer-server.ts')

test('serves the packaged renderer from a loopback HTTP origin', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-renderer-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<main>Hermes</main>')
  fs.mkdirSync(path.join(root, 'assets'))
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'globalThis.loaded = true')
  const server = await startRendererServer(root, { port: 0 })

  t.onTestFinished(async () => {
    await server.close()
    fs.rmSync(root, { force: true, recursive: true })
  })

  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/)

  const index = await fetch(`${server.origin}/`)
  assert.equal(index.status, 200)
  assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(await index.text(), '<main>Hermes</main>')

  const asset = await fetch(`${server.origin}/assets/app.js`)
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(await asset.text(), 'globalThis.loaded = true')
})

test('falls back to the SPA shell for extensionless paths', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-renderer-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<main>Hermes</main>')
  const server = await startRendererServer(root, { port: 0 })

  t.onTestFinished(async () => {
    await server.close()
    fs.rmSync(root, { force: true, recursive: true })
  })

  const response = await fetch(`${server.origin}/session/abc`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '<main>Hermes</main>')
})

// Regression: the default port was fixed and any bind failure rejected. main.ts
// awaits this server before createWindow(), so an occupied 47891 meant startup
// never reached window creation — a blank launch with no clue why.
test('a taken port never blocks startup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-renderer-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<main>Hermes</main>')

  // Occupy a real port, then ask the renderer server for that exact port.
  const squatter = http.createServer((_request, response) => response.end('squatter'))
  await new Promise<void>(done => squatter.listen({ host: '127.0.0.1', port: 0 }, () => done()))
  const takenPort = (squatter.address() as AddressInfo).port

  const server = await startRendererServer(root, { port: takenPort })

  t.onTestFinished(async () => {
    await server.close()
    await new Promise<void>(done => squatter.close(() => done()))
    fs.rmSync(root, { force: true, recursive: true })
  })

  const boundPort = Number(new URL(server.origin).port)
  assert.notEqual(boundPort, takenPort, 'must not claim the occupied port')
  assert.ok(boundPort > 0, 'must bind a real port')

  // The fallback server still serves the renderer, and the squatter is untouched.
  const index = await fetch(`${server.origin}/`)
  assert.equal(index.status, 200)
  assert.equal(await index.text(), '<main>Hermes</main>')
  assert.equal(await (await fetch(`http://127.0.0.1:${takenPort}/`)).text(), 'squatter')
})

test('a taken port falls back to a fixed neighbour, so the origin stays stable', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-renderer-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<main>Hermes</main>')
  const squatter = http.createServer((_request, response) => response.end('squatter'))
  await new Promise<void>(done => squatter.listen({ host: '127.0.0.1', port: 0 }, () => done()))
  const takenPort = (squatter.address() as AddressInfo).port

  const first = await startRendererServer(root, { port: takenPort })
  const firstOrigin = first.origin
  await first.close()
  const second = await startRendererServer(root, { port: takenPort })

  t.onTestFinished(async () => {
    await second.close()
    await new Promise<void>(done => squatter.close(() => done()))
    fs.rmSync(root, { force: true, recursive: true })
  })

  assert.equal(firstOrigin, `http://127.0.0.1:${takenPort + 1}`)
  assert.equal(second.origin, firstOrigin, 'a relaunch against the same squatter keeps its origin')
})

test('each data dir gets its own stable renderer port', () => {
  const a = rendererPortFor('/Users/x/Library/Application Support/Hermes-work', false)
  const b = rendererPortFor('/Users/x/Library/Application Support/Hermes-play', false)

  assert.equal(rendererPortFor('/anything', true), DEFAULT_PORT)
  assert.equal(rendererPortFor('/Users/x/Library/Application Support/Hermes-work', false), a)
  assert.notEqual(a, b)
  // Clear of the default instance's port and its fallbacks.
  assert.ok(a > DEFAULT_PORT + 3 && b > DEFAULT_PORT + 3)
})

test('serves a script-free blank document for the storage migration', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-renderer-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<script src="app.js"></script>')
  const server = await startRendererServer(root, { port: 0 })

  t.onTestFinished(async () => {
    await server.close()
    fs.rmSync(root, { force: true, recursive: true })
  })

  const blank = await fetch(`${server.origin}${BLANK_PATH}`)
  assert.equal(blank.status, 200)
  assert.equal(await blank.text(), '<!doctype html>')
})

test('rejects paths outside the renderer root', () => {
  const root = path.resolve('/tmp/hermes-renderer')

  assert.equal(rendererRequestPath(root, '/%E0%A4%A'), null)
  assert.equal(rendererRequestPath(root, '/%2e%2e%2fetc/passwd'), null)
})
