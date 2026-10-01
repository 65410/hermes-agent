import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateLegacyRendererStorage } from './renderer-storage-migration'

const ORIGIN = 'http://127.0.0.1:47891'

// Stand-in for a WebContentsView: one localStorage per origin, every file://
// page sharing the same one, exactly like Chromium.
function fakeBrowser(stores: Record<string, Record<string, string>>, { failLoad = false } = {}) {
  const opened = { closed: 0 }

  const openPage = () => {
    let store: Record<string, string> = {}

    return {
      close: () => void opened.closed++,
      load: async (url: string) => {
        if (failLoad) {
          throw new Error('ERR_FAILED')
        }

        const key = url.startsWith('file:') ? 'file://' : new URL(url).origin
        store = stores[key] ??= {}
      },
      run: async (script: string) => {
        const localStorage = {
          setItem: (k: string, v: string) => void (store[k] = v)
        }

        return script === 'Object.entries(localStorage)'
          ? Object.entries(store)
          : new Function('localStorage', script)(localStorage)
      }
    }
  }

  return { openPage, opened }
}

describe('migrateLegacyRendererStorage', () => {
  const dirs: string[] = []

  const userData = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-storage-'))
    dirs.push(dir)

    return dir
  }

  afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { force: true, recursive: true })))

  it('carries file:// settings over defaults the new origin already wrote, once', async () => {
    const stores: Record<string, Record<string, string>> = {
      'file://': { 'hermes.desktop.translucency.v2': '{"intensity":10}', theme: 'nous' },
      [ORIGIN]: { 'hermes.desktop.translucency.v2': '{"intensity":29}', 'new-only': 'kept' }
    }

    const dir = userData()
    const { openPage, opened } = fakeBrowser(stores)
    const log: string[] = []
    await migrateLegacyRendererStorage({ log: line => log.push(line), openPage, origin: ORIGIN, userData: dir })

    expect(stores[ORIGIN]).toEqual({
      'hermes.desktop.translucency.v2': '{"intensity":10}',
      'new-only': 'kept',
      theme: 'nous'
    })
    expect(opened.closed).toBe(1)
    expect(log[0]).toContain('carried 2')
    expect(fs.readdirSync(dir)).toEqual(['renderer-storage-origin.json'])

    // Settings changed after the migration are never overwritten again.
    stores[ORIGIN].theme = 'chosen-later'
    await migrateLegacyRendererStorage({ log: () => {}, openPage, origin: ORIGIN, userData: dir })
    expect(stores[ORIGIN].theme).toBe('chosen-later')
    expect(opened.closed).toBe(1)
  })

  it('retries next launch when the migration fails, without blocking startup', async () => {
    const dir = userData()
    const failing = fakeBrowser({ 'file://': { theme: 'nous' } }, { failLoad: true })
    const log: string[] = []

    await migrateLegacyRendererStorage({
      log: line => log.push(line),
      openPage: failing.openPage,
      origin: ORIGIN,
      userData: dir
    })

    expect(log[0]).toContain('retrying next launch')
    expect(failing.opened.closed).toBe(1)
    expect(fs.readdirSync(dir)).toEqual([])

    const stores = { 'file://': { theme: 'nous' } }
    await migrateLegacyRendererStorage({
      log: () => {},
      openPage: fakeBrowser(stores).openPage,
      origin: ORIGIN,
      userData: dir
    })
    expect(stores[ORIGIN]).toEqual({ theme: 'nous' })
  })

  it('never lets a destroyed page escape into startup', async () => {
    const dir = userData()
    const stores = { 'file://': { theme: 'nous' } }
    const { openPage } = fakeBrowser(stores)

    const destroyed = () => ({
      ...openPage(),
      close: () => {
        throw new TypeError('Object has been destroyed')
      }
    })

    await expect(
      migrateLegacyRendererStorage({ log: () => {}, openPage: destroyed, origin: ORIGIN, userData: dir })
    ).resolves.toBeUndefined()
    expect(stores[ORIGIN]).toEqual({ theme: 'nous' })
  })

  it('marks a fresh install done without touching the new origin', async () => {
    const dir = userData()
    const stores: Record<string, Record<string, string>> = {}

    await migrateLegacyRendererStorage({
      log: () => {},
      openPage: fakeBrowser(stores).openPage,
      origin: ORIGIN,
      userData: dir
    })

    expect(stores[ORIGIN]).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'renderer-storage-origin.json'), 'utf8'))).toEqual({
      origins: [ORIGIN]
    })
  })
})
