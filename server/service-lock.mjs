import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'

// The child holds only an OS file lock, never credentials. EOF releases the lock
// even if the parent is killed and cannot run JavaScript shutdown handlers.
const keeper = "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); process.stdout.write('locked\\n')"
export async function acquireServiceLock(directory, run = spawn) {
  if (process.platform !== 'linux') throw new Error('service_lock_unavailable')
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = await open(join(directory, 'lease'), 'a', 0o600)
    await file.close()
  } catch { throw new Error('service_lock_unavailable') }
  return new Promise((resolve, reject) => {
    let child
    try {
      child = run('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '--no-fork',
        join(directory, 'lease'), process.execPath, '--input-type=module', '-e', keeper], { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch { reject(new Error('service_lock_unavailable')); return }
    let held = false
    let settled = false
    let output = ''
    let finished
    const done = new Promise(resolve => { finished = resolve })
    const timeout = setTimeout(() => { child.kill('SIGKILL'); fail() }, 5000)
    function fail(code = 'service_lock_unavailable') {
      if (settled) return
      settled = true; clearTimeout(timeout)
      reject(new Error(code))
    }
    child.once('error', () => { fail(); held = false; finished() })
    child.stdin.on('error', () => { child.kill('SIGKILL'); fail() })
    child.once('close', code => { held = false; fail(code === 73 ? 'service_locked' : 'service_lock_unavailable'); finished() })
    child.stdout.on('data', data => {
      output += data.toString()
      if (output === 'locked\n' && !settled) {
        settled = true; held = true; clearTimeout(timeout)
        resolve({
          get held() { return held },
          async close() {
            child.stdin.end()
            const stop = setTimeout(() => child.kill('SIGKILL'), 1000)
            try { await done } finally { clearTimeout(stop) }
          },
        })
      } else if (output.length > 32) { child.kill('SIGKILL'); fail() }
    })
  })
}
