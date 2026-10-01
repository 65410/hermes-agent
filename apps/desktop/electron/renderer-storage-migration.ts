import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BLANK_PATH } from './renderer-server'

// The packaged renderer moved from file:// to a loopback HTTP origin, and
// localStorage is partitioned by origin. Without this, an upgraded install
// boots with every renderer setting (theme, glass, layout, composer model…)
// reset to defaults. Copy the file:// store across once per origin.

const MARKER_FILE = 'renderer-storage-origin.json'
const LEGACY_PAGE_FILE = 'renderer-storage-legacy.html'
const TIMEOUT_MS = 10_000

interface BackgroundPage {
  close: () => void
  load: (url: string) => Promise<unknown>
  run: (script: string) => Promise<unknown>
}

interface MigrationOptions {
  log: (line: string) => void
  openPage: () => BackgroundPage
  origin: string
  userData: string
}

function migratedOrigins(userData: string): string[] {
  try {
    const origins = JSON.parse(fs.readFileSync(path.join(userData, MARKER_FILE), 'utf8'))?.origins

    return Array.isArray(origins) ? origins : []
  } catch {
    return []
  }
}

function rememberMigratedOrigin(userData: string, origin: string) {
  const origins = [...new Set([...migratedOrigins(userData), origin])]

  fs.writeFileSync(path.join(userData, MARKER_FILE), JSON.stringify({ origins }))
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
  })

  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Copy the legacy file:// localStorage into `origin`, once.
 *
 * Every file:// page shares one storage area, so a blank file page reads it
 * without booting the app; the writes go through the renderer server's blank
 * document. Legacy values win over the new origin's: anything stored there
 * predates this migration, which means it was written by a build that started
 * from defaults. Never throws — a failure leaves the marker unset so the next
 * launch retries, and startup continues either way.
 */
async function migrateLegacyRendererStorage({ log, openPage, origin, userData }: MigrationOptions) {
  if (migratedOrigins(userData).includes(origin)) {
    return
  }

  const legacyPage = path.join(userData, LEGACY_PAGE_FILE)
  const page = openPage()

  try {
    const count = await withTimeout(
      (async () => {
        fs.writeFileSync(legacyPage, '<!doctype html>')
        await page.load(pathToFileURL(legacyPage).toString())
        const entries = await page.run('Object.entries(localStorage)')

        if (!Array.isArray(entries) || entries.length === 0) {
          return 0
        }

        await page.load(`${origin}${BLANK_PATH}`)
        await page.run(`${JSON.stringify(entries)}.forEach(([k, v]) => localStorage.setItem(k, v))`)

        return entries.length
      })()
    )

    rememberMigratedOrigin(userData, origin)
    log(`[renderer-storage] carried ${count} file:// localStorage keys to ${origin}`)
  } catch (error) {
    log(`[renderer-storage] file:// migration to ${origin} failed, retrying next launch: ${error}`)
  } finally {
    try {
      page.close()
      fs.rmSync(legacyPage, { force: true })
    } catch {
      // Cleanup must not turn a finished (or already-logged) migration into a startup failure.
    }
  }
}

export { migrateLegacyRendererStorage }
export type { BackgroundPage }
