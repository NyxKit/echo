import { windows, hostHelper, credentialDirectory } from './platform.mjs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { acquireServiceLock } from './service-lock.mjs'

const maxBytes = 100_000, partBytes = 4500, maxParts = Math.ceil(maxBytes / partBytes)
const marker = '__echoSecretStore'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function unavailable() { return new Error('secure_store_unavailable') }
function parse(value) { try { return JSON.parse(value) } catch { throw unavailable() } }
function manifest(value) {
  const record = parse(value)
  if (!record || typeof record !== 'object' || !(marker in record)) return undefined
  if (record[marker] !== 1 || !['a', 'b'].includes(record.slot) || !Number.isInteger(record.bytes)
    || record.bytes < 1 || record.bytes > maxBytes || record.parts !== Math.ceil(record.bytes / partBytes)
    || !/^[a-f0-9]{64}$/.test(record.sha256)) throw unavailable()
  return record
}

export function createSecureStore(run = spawn, { directory = credentialDirectory() } = {}) {
  const attributes = ['application', 'echo-chatgpt', 'purpose', 'connection']
  let lock
  let closed = false
  let closing
  let operations = Promise.resolve()
  function serialized(action) {
    if (closed) return Promise.reject(unavailable())
    const pending = operations.then(action)
    operations = pending.catch(() => {})
    return pending
  }
  async function acquire() {
    if (closed) throw new Error('secure_store_unavailable')
    if (!lock) {
      const pending = acquireServiceLock(join(directory, 'service.lock'))
      lock = pending
      pending.catch(() => { if (lock === pending) lock = undefined })
    }
    const lease = await lock
    if (closed || !lease.held) throw new Error('service_lock_unavailable')
    return lease
  }
  function execute(operation, input, part) {
    if (!windows && process.platform !== 'linux') return Promise.reject(new Error('secure_store_unavailable'))
    return new Promise((resolve, reject) => {
      const target = part ? ['application', 'echo-chatgpt', 'purpose', 'connection-chunk', 'slot', part.slot, 'part', String(part.index)] : attributes
      const args = operation === 'store'
        ? ['store', '--label=Echo ChatGPT connection', ...target] : [operation, ...(operation === 'search' ? ['--all'] : []), ...target]
      const child = run(windows ? hostHelper() : 'secret-tool', windows ? ['credential-' + operation] : args,
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const chunks = []
      let length = 0
      let diagnostic = false
      let settled = false
      const timer = setTimeout(() => { child.kill(); finish(false) }, 30_000)
      function finish(ok) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (ok) resolve(Buffer.concat(chunks).toString('utf8').trim())
        else reject(new Error('secure_store_unavailable'))
      }
      child.on('error', () => finish(false))
      child.stdin.on('error', () => finish(false))
      child.stderr.on('data', data => { diagnostic ||= data.length > 0 })
      child.stdout.on('data', data => {
        length += data.length
        if (length > maxBytes) { child.kill(); finish(false) }
        else chunks.push(Buffer.from(data))
      })
      child.on('close', code => finish((code === 0 && !(operation === 'search' && diagnostic)) || (!windows && ['lookup', 'clear'].includes(operation) && code === 1 && !length && !diagnostic)))
      child.stdin.end(input ?? '')
    })
  }
  function assertLease(lease) { if (!lease.held || closed) throw new Error('service_lock_unavailable') }
  async function readRoot() {
    const value = await execute('lookup')
    // A locked item can look like an absent password to `lookup`. Search
    // includes locked items; capture its output privately and fail closed.
    if (!windows && !value && await execute('search')) throw unavailable()
    return value
  }
  async function readValue() {
    const value = await readRoot()
    if (!value || windows) return value
    const root = manifest(value)
    if (!root) return value
    const chunks = []
    for (let index = 0; index < root.parts; index++) {
      const encoded = await execute('lookup', undefined, { slot: root.slot, index })
      const chunk = Buffer.from(encoded, 'base64')
      if (chunk.toString('base64') !== encoded || chunk.length !== Math.min(partBytes, root.bytes - index * partBytes)) throw unavailable()
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    if (digest(bytes) !== root.sha256) throw unavailable()
    return bytes.toString('utf8')
  }
  return {
    read: () => serialized(async () => {
      const lease = await acquire()
      const value = await readValue()
      assertLease(lease)
      if (!value) return undefined
      return parse(value)
    }),
    write: record => serialized(async () => {
      const lease = await acquire()
      const value = JSON.stringify(record)
      if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) throw unavailable()
      if (windows) {
        await execute('store', value)
        assertLease(lease)
        if (await execute('lookup') !== value) throw unavailable()
        return
      }
      const previous = await readRoot()
      const current = previous ? manifest(previous) : undefined
      const slot = current?.slot === 'a' ? 'b' : 'a'
      const bytes = Buffer.from(value), parts = Math.ceil(bytes.length / partBytes)
      for (let index = 0; index < parts; index++) {
        assertLease(lease)
        const part = { slot, index }, encoded = bytes.subarray(index * partBytes, (index + 1) * partBytes).toString('base64')
        await execute('store', encoded, part)
        if (await execute('lookup', undefined, part) !== encoded) throw unavailable()
      }
      const root = JSON.stringify({ [marker]: 1, slot, parts, bytes: bytes.length, sha256: digest(bytes) })
      assertLease(lease)
      await execute('store', root)
      if (await execute('lookup') !== root) throw unavailable()
      // Keep only the published parts. A crash or cleanup failure leaves at
      // most two bounded slots; the next successful replacement retries this.
      for (const cleanupSlot of ['a', 'b']) for (let index = cleanupSlot === slot ? parts : 0; index < maxParts; index++) {
        assertLease(lease)
        await execute('clear', undefined, { slot: cleanupSlot, index })
      }
      assertLease(lease)
    }),
    close() {
      closed = true
      closing ??= (async () => {
        await operations
        try { await (await lock)?.close() } catch { /* A failed acquisition owns no lock. */ }
      })()
      return closing
    },
  }
}
