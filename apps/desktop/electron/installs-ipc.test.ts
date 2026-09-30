/**
 * Tests for electron/installs-ipc.ts.
 *
 * The IPC layer is exercised with a fake ipcMain and a fake runner, so these
 * tests need no electron and no child process.
 */

import assert from 'node:assert/strict'

import { afterEach, beforeEach, test } from 'vitest'

import {
  type InstallsRunOutcome,
  registerInstallsIpc,
  resetInstallsNoticeLatchForTests,
  runInstallsNoticeCheck
} from './installs-ipc'

const SAMPLE_LIST = {
  current: 'abc',
  installs: [
    {
      id: 'abc',
      root: '/home/u/hermes-agent',
      steward: 'git',
      version: '1.2.3',
      sources: ['path'],
      current: true,
      package_full_name: null,
      removable: false,
      action: 'refuse',
      refusal: 'not removed: this install is running'
    }
  ],
  launchers: [],
  notice: { count: 0, dismissed: false }
}

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>

function fakeIpcMain(): { handlers: Map<string, Handler>; handle: (channel: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>()

  return {
    handlers,
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    }
  }
}

const call = (ipc: ReturnType<typeof fakeIpcMain>, channel: string, payload?: unknown): Promise<unknown> =>
  ipc.handlers.get(channel)!(null, payload)

test('registerInstallsIpc list parses the CLI JSON', async () => {
  const ipc = fakeIpcMain()
  const runs: string[][] = []

  registerInstallsIpc({
    ipcMain: ipc,
    runInstalls: args => {
      runs.push(args)

      return Promise.resolve({ code: 0, stdout: `noise\n${JSON.stringify(SAMPLE_LIST, null, 2)}\n`, stderr: '' })
    },
    logDebug: () => undefined
  })

  const list = (await call(ipc, 'hermes:installs:list')) as typeof SAMPLE_LIST | null

  assert.deepEqual(runs, [['installs', 'list', '--json']])
  assert.equal(list?.current, 'abc')
  assert.equal(list?.installs[0]?.removable, false)
})

test('registerInstallsIpc list returns null on a non-zero exit and bad JSON', async () => {
  const ipc = fakeIpcMain()

  registerInstallsIpc({
    ipcMain: ipc,
    runInstalls: () => Promise.resolve({ code: 1, stdout: '', stderr: 'boom' }),
    logDebug: () => undefined
  })

  assert.equal(await call(ipc, 'hermes:installs:list'), null)

  const badIpc = fakeIpcMain()

  registerInstallsIpc({
    ipcMain: badIpc,
    runInstalls: () => Promise.resolve({ code: 0, stdout: 'not json', stderr: '' }),
    logDebug: () => undefined
  })

  assert.equal(await call(badIpc, 'hermes:installs:list'), null)
})

test('registerInstallsIpc remove validates the id before building argv', async () => {
  const ipc = fakeIpcMain()
  const runs: string[][] = []

  registerInstallsIpc({
    ipcMain: ipc,
    runInstalls: args => {
      runs.push(args)

      return Promise.resolve({ code: 0, stdout: 'Removed.', stderr: '' })
    },
    logDebug: () => undefined
  })

  const bad = (await call(ipc, 'hermes:installs:remove', { id: 'rm -rf /' })) as { ok: boolean; error?: string }

  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'invalid-id')
  assert.deepEqual(runs, [])

  const good = (await call(ipc, 'hermes:installs:remove', { id: 'abc123' })) as { ok: boolean }

  assert.equal(good.ok, true)
  assert.deepEqual(runs, [['installs', 'remove', 'abc123', '--yes']])
})

test('registerInstallsIpc remove surfaces the CLI refusal on exit 1', async () => {
  const ipc = fakeIpcMain()

  registerInstallsIpc({
    ipcMain: ipc,
    runInstalls: () => Promise.resolve({ code: 1, stdout: '', stderr: 'not removed: this install is running' }),
    logDebug: () => undefined
  })

  const result = (await call(ipc, 'hermes:installs:remove', { id: 'abc' })) as { ok: boolean; message?: string }

  assert.equal(result.ok, false)
  assert.equal(result.message, 'not removed: this install is running')
})

test('registerInstallsIpc dismiss runs the dismiss argv', async () => {
  const ipc = fakeIpcMain()
  const runs: string[][] = []

  registerInstallsIpc({
    ipcMain: ipc,
    runInstalls: args => {
      runs.push(args)

      return Promise.resolve({ code: 0, stdout: 'ok', stderr: '' })
    },
    logDebug: () => undefined
  })

  const result = (await call(ipc, 'hermes:installs:dismiss')) as { ok: boolean }

  assert.equal(result.ok, true)
  assert.deepEqual(runs, [['installs', 'dismiss']])
})

// --- runInstallsNoticeCheck ---

const NOTICED = {
  current: 'abc',
  installs: [],
  launchers: [],
  notice: { count: 2, dismissed: false }
}

let sent: { count: number }[]
let debugs: string[]
let runnerOutcome: InstallsRunOutcome
let runnerShouldReject: boolean

const runner = (): Promise<InstallsRunOutcome> =>
  runnerShouldReject ? Promise.reject(new Error('spawn failed')) : Promise.resolve(runnerOutcome)

const check = (): void =>
  runInstallsNoticeCheck({
    runInstalls: runner,
    sendNotice: payload => sent.push(payload),
    logDebug: message => debugs.push(message)
  })

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(() => {
  resetInstallsNoticeLatchForTests()
  sent = []
  debugs = []
  runnerOutcome = { code: 0, stdout: JSON.stringify(NOTICED), stderr: '' }
  runnerShouldReject = false
})

afterEach(() => {
  runnerOutcome = { code: null, stdout: '', stderr: '' }
  runnerShouldReject = false
})

test('boot notice sends once when other installs exist and are not dismissed', async () => {
  check()
  await wait(10)

  assert.deepEqual(sent, [{ count: 2 }])
  assert.deepEqual(debugs, [])
})

test('boot notice stays silent when dismissed, empty, failed, or malformed', async () => {
  for (const outcome of [
    { code: 0, stdout: JSON.stringify({ ...NOTICED, notice: { count: 2, dismissed: true } }), stderr: '' },
    { code: 0, stdout: JSON.stringify({ ...NOTICED, notice: { count: 0, dismissed: false } }), stderr: '' },
    { code: 1, stdout: '', stderr: 'boom' },
    { code: 0, stdout: 'half printed {', stderr: '' }
  ]) {
    runnerOutcome = outcome
    check()
    await wait(10)
  }

  assert.deepEqual(sent, [])
})

test('boot notice is shown at most once per app launch', async () => {
  check()
  await wait(10)
  check()
  await wait(10)

  assert.deepEqual(sent, [{ count: 2 }])
})

test('boot notice failures are logged, never thrown', async () => {
  runnerShouldReject = true
  check()
  await wait(10)

  assert.deepEqual(sent, [])
  assert.equal(debugs.length, 1)
  assert.match(debugs[0]!, /spawn failed/)
})
