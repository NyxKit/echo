import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { acquireServiceLock } from './service-lock.mjs'

export function createSecureStore(run = spawn, { directory = join(homedir(), '.local', 'state', 'echo-chatgpt') } = {}) {
  const attributes = ['application', 'echo-chatgpt', 'purpose', 'connection']
  let lock
  let closed = false
  let closing
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
  function execute(operation, input) {
    if (process.platform !== 'linux') return Promise.reject(new Error('secure_store_unavailable'))
    return new Promise((resolve, reject) => {
      const child = run('secret-tool', operation === 'store'
        ? ['store', '--label=Echo ChatGPT connection', ...attributes] : [operation, ...attributes],
      { stdio: ['pipe', 'pipe', 'pipe'] })
      let output = ''
      let diagnostic = false
      let settled = false
      const timer = setTimeout(() => { child.kill(); finish(false) }, 30_000)
      function finish(ok) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (ok) resolve(output.trim())
        else reject(new Error('secure_store_unavailable'))
      }
      child.on('error', () => finish(false))
      child.stdin.on('error', () => finish(false))
      child.stderr.on('data', data => { diagnostic ||= data.length > 0 })
      child.stdout.on('data', data => {
        output += data.toString()
        if (output.length > 100_000) { child.kill(); finish(false) }
      })
      child.on('close', code => finish(code === 0 || (operation === 'lookup' && code === 1 && !output && !diagnostic)))
      child.stdin.end(input ?? '')
    })
  }
  return {
    async read() {
      const lease = await acquire()
      const value = await execute('lookup')
      if (!lease.held || closed) throw new Error('service_lock_unavailable')
      if (!value) return undefined
      try { return JSON.parse(value) } catch { throw new Error('secure_store_unavailable') }
    },
    async write(record) {
      const lease = await acquire()
      const value = JSON.stringify(record)
      await execute('store', value)
      if (!lease.held || closed) throw new Error('service_lock_unavailable')
      if (await execute('lookup') !== value) throw new Error('secure_store_unavailable')
    },
    close() {
      closed = true
      closing ??= (async () => {
        try { await (await lock)?.close() } catch { /* A failed acquisition owns no lock. */ }
      })()
      return closing
    },
  }
}
