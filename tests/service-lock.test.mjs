import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { acquireServiceLock } from '../server/service-lock.mjs'
import { createSecureStore } from '../server/secure-store.mjs'

// Lock tests use disposable directories only; no real keyring or credentials.
const cleanup = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'echo-synthetic-lock-'))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}
async function acquire(path) {
  const lease = await acquireServiceLock(path)
  cleanup.push(() => lease.close())
  return lease
}

describe.runIf(process.platform === 'linux')('connection service OS lock', () => {
  it('reuses a leftover directory, excludes another owner, and releases without deleting the lock file', async () => {
    const path = join(await directory(), 'service.lock')
    await mkdir(path, { mode: 0o700 })
    const first = await acquire(path)
    await expect(acquireServiceLock(path)).rejects.toThrow('service_locked')
    expect(first.held).toBe(true)
    await first.close()
    expect(first.held).toBe(false)
    expect(await readdir(path)).toEqual(['lease'])
    const second = await acquire(path)
    expect(second.held).toBe(true)
    await first.close()
    await expect(acquireServiceLock(path)).rejects.toThrow('service_locked')
  })

  it('releases after its owner is killed without JavaScript cleanup', async () => {
    const path = join(await directory(), 'service.lock')
    const source = new URL('../server/service-lock.mjs', import.meta.url).href
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { acquireServiceLock } = await import(process.argv[1]);
      await acquireServiceLock(process.argv[2]);
      process.stdout.write('ready');
    `, source, path], { stdio: ['ignore', 'pipe', 'ignore'] })
    const exited = once(child, 'exit')
    cleanup.push(async () => { child.kill('SIGKILL'); await exited })
    await once(child.stdout, 'data')
    await expect(acquireServiceLock(path)).rejects.toThrow('service_locked')
    child.kill('SIGKILL')
    await exited
    let replacement
    await vi.waitFor(async () => { replacement = await acquire(path) }, { timeout: 3000 })
    expect(replacement.held).toBe(true)
  })

  it('distinguishes a lock setup failure from an active owner', async () => {
    const path = join(await directory(), 'not-a-directory')
    await writeFile(path, 'synthetic')
    await expect(acquireServiceLock(path)).rejects.toThrow('service_lock_unavailable')
    await expect(acquireServiceLock(await directory(), () => { throw new Error('ENOENT') })).rejects.toThrow('service_lock_unavailable')
  })

  it('releases an acquisition still pending when the store closes without accessing the keyring', async () => {
    const path = await directory()
    const secretTool = vi.fn(() => { throw new Error('Must not call the real keyring') })
    const store = createSecureStore(secretTool, { directory: path })
    const read = expect(store.read()).rejects.toThrow()
    await store.close()
    await read
    expect(secretTool).not.toHaveBeenCalled()
    expect((await acquire(join(path, 'service.lock'))).held).toBe(true)
    await expect(store.read()).rejects.toThrow('secure_store_unavailable')
  })
})
