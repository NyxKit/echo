import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureStore } from '../server/secure-store.mjs'

// Anonymous pipes and an in-memory synthetic keyring. Never invokes secret-tool.
function keyring() {
  const values = new Map()
  const state = { values, fail: undefined, loseAcknowledgement: false, locked: false }
  state.run = (command, args) => {
    expect(command).toBe('secret-tool')
    const [operation, ...rest] = args
    const attributes = rest.filter(value => !value.startsWith('--label=') && value !== '--all')
    const pairs = Object.fromEntries(Array.from({ length: attributes.length / 2 }, (_, index) => attributes.slice(index * 2, index * 2 + 2)))
    const key = pairs.purpose === 'connection' ? 'root' : `${pairs.slot}:${pairs.part}`
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = () => { child.emit('close', 1); return true }
    const input = []
    child.stdin.on('data', chunk => input.push(Buffer.from(chunk)))
    child.stdin.on('finish', () => queueMicrotask(() => {
      if (state.fail?.(operation, key)) { child.stderr.write('Synthetic keyring failure'); child.emit('close', 1); return }
      if (operation === 'store') {
        const bytes = Buffer.concat(input)
        // Emulate the actual CLI's stdin ceiling, including truncation.
        values.set(key, bytes.subarray(0, 8192).toString('utf8'))
        if (key === 'root' && state.loseAcknowledgement) { state.loseAcknowledgement = false; child.emit('close', 1); return }
      } else if (operation === 'clear') values.delete(key)
      else if (operation === 'search') { if (values.has(key)) child.stdout.write('Synthetic matching item') }
      else if (operation === 'lookup') {
        if (state.locked || !values.has(key)) { child.emit('close', 1); return }
        // Split UTF-8 code points across chunks, as a pipe is allowed to do.
        const bytes = Buffer.from(values.get(key))
        for (let i = 0; i < bytes.length; i += 7) child.stdout.write(bytes.subarray(i, i + 7))
      }
      child.emit('close', 0)
    }))
    return child
  }
  return state
}

const cleanup = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'echo-synthetic-secrets-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const ring = keyring()
  const open = () => { const store = createSecureStore(ring.run, { directory }); cleanup.push(() => store.close()); return store }
  return { ring, open, store: open() }
}

describe.runIf(process.platform === 'linux')('bounded Secret Service records', () => {
  it('distinguishes an empty keyring from a locked existing connection', async () => {
    const { ring, store } = await setup()
    expect(await store.read()).toBeUndefined()
    await store.write({ synthetic: true })
    ring.locked = true
    await expect(store.read()).rejects.toThrow('secure_store_unavailable')
    await expect(store.write({ disconnected: true })).rejects.toThrow('secure_store_unavailable')
    ring.locked = false
    expect(await store.read()).toEqual({ synthetic: true })
  })
  it('migrates legacy Unicode records, survives reopening, and clears old parts on disconnect', async () => {
    const { ring, store, open } = await setup()
    const legacy = { synthetic: '€'.repeat(7) }
    ring.values.set('root', JSON.stringify(legacy))
    expect(await store.read()).toEqual(legacy)
    const record = { synthetic: '🧪'.repeat(12000) }
    await store.write(record)
    expect(await store.read()).toEqual(record)
    expect([...ring.values.values()].every(value => Buffer.byteLength(value) < 8192)).toBe(true)
    await store.close()
    const reopened = open()
    expect(await reopened.read()).toEqual(record)
    await reopened.write({ disconnected: true })
    expect(await reopened.read()).toEqual({ disconnected: true })
    expect(ring.values.size).toBe(2)
  })

  it('preserves the previous committed record after a partial write and retries after reopening', async () => {
    const { ring, store, open } = await setup()
    const previous = { synthetic: 'previous'.repeat(2000) }, replacement = { synthetic: 'replacement'.repeat(2000) }
    await store.write(previous)
    ring.fail = (operation, key) => operation === 'store' && key === 'b:1'
    await expect(store.write(replacement)).rejects.toThrow('secure_store_unavailable')
    await store.close()
    const reopened = open()
    expect(await reopened.read()).toEqual(previous)
    ring.fail = undefined
    await reopened.write(replacement)
    expect(await reopened.read()).toEqual(replacement)
    expect([...ring.values.keys()].some(key => key.startsWith('a:'))).toBe(false)
  })

  it('retains a published replacement when its acknowledgement is lost', async () => {
    const { ring, store } = await setup()
    await store.write({ synthetic: 'before' })
    ring.loseAcknowledgement = true
    const replacement = { synthetic: 'after'.repeat(5000) }
    await expect(store.write(replacement)).rejects.toThrow('secure_store_unavailable')
    expect(await store.read()).toEqual(replacement)
    await store.write({ disconnected: true })
    expect(ring.values.size).toBe(2)
  })

  it('rejects missing or changed parts and oversized writes without returning partial credentials', async () => {
    const { ring, store } = await setup()
    const record = { synthetic: 'generated'.repeat(2000) }
    await store.write(record)
    await expect(store.write({ synthetic: 'a'.repeat(100000) })).rejects.toThrow('secure_store_unavailable')
    expect(await store.read()).toEqual(record)
    const saved = ring.values.get('a:0')
    ring.values.delete('a:0')
    await expect(store.read()).rejects.toThrow('secure_store_unavailable')
    ring.values.set('a:0', Buffer.alloc(4500, 'x').toString('base64'))
    await expect(store.read()).rejects.toThrow('secure_store_unavailable')
    ring.values.set('a:0', saved)
    expect(await store.read()).toEqual(record)
  })

  it('serializes concurrent replacements and reads, and reports cleanup failure for retry', async () => {
    const { ring, store } = await setup()
    const first = { synthetic: 'one'.repeat(5000) }, second = { synthetic: 'two'.repeat(5000) }
    const operations = [store.write(first), store.read(), store.write(second), store.read()]
    const results = await Promise.all(operations)
    expect(results[1]).toEqual(first); expect(results[3]).toEqual(second)
    ring.fail = (operation, key) => operation === 'clear' && key === 'b:0'
    await expect(store.write({ disconnected: true })).rejects.toThrow('secure_store_unavailable')
    expect(await store.read()).toEqual({ disconnected: true })
    ring.fail = undefined
    await store.write({ disconnected: true })
    expect(ring.values.size).toBe(2)
  })
})
