import { windows, hostHelper } from './platform.mjs'
import { fork, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { callControl } from './local-control.mjs'
import { readInstance } from './runtime-state.mjs'
import { join, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function openBrowser(target) {
  let permitted = /^http:\/\/127\.0\.0\.1:\d+$/.test(target)
  try { permitted ||= /^launch-[a-f0-9-]{36}\.html$/.test(basename(fileURLToPath(target))) } catch { /* Not a local launch file. */ }
  if (!permitted) return Promise.reject(new Error('browser_failed'))
  return new Promise((resolve, reject) => {
    const child = spawn(windows ? hostHelper() : 'xdg-open', windows ? ['open', target] : [target], { stdio: 'ignore', detached: true, windowsHide: true })
    const timeout = setTimeout(() => { child.unref(); resolve() }, 3000)
    child.once('error', () => { clearTimeout(timeout); reject(new Error('browser_failed')) })
    child.once('exit', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error('browser_failed')) })
  })
}

async function verifiedState(directory) {
  const state = await readInstance(directory)
  if (!state) return undefined
  try { return { state, result: await callControl(state) } }
  catch { return undefined }
}

export async function instanceStatus(directory) {
  const current = await verifiedState(directory)
  if (!current) return { status: 'unavailable' }
  return { status: current.result.status, origin: `http://127.0.0.1:${current.state.port}` }
}

export async function launch({ directory, root, port, libraryDirectory, background = false, browser = openBrowser, spawnHost = fork, timeoutMs = 12_000 }) {
  const present = await verifiedState(directory)
  async function opened(current, reused) {
    if (current.result.status !== 'ready') throw new Error('service_locked')
    if (port !== undefined && port !== current.state.port) throw new Error('port_mismatch')
    const origin = `http://127.0.0.1:${current.state.port}`
    if (!background) {
      if (current.result.library) {
        const { launchId } = await callControl(current.state, 'launch')
        await browser(pathToFileURL(join(directory, `launch-${launchId}.html`)).href)
      } else await browser(origin)
    }
    return { status: 'ready', origin, reused }
  }
  if (present) return opened(present, true)
  const child = spawnHost(new URL('./host.mjs', import.meta.url), [], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  let failure
  let ready = false
  child.on('error', () => { failure = 'startup_failed' })
  child.on('message', message => {
    if (message?.status === 'failed') failure = message.code
    if (message?.status === 'ready') ready = true
  })
  child.on('exit', () => { if (!ready && !failure) failure = 'startup_failed' })
  child.send({ directory, root, port, libraryDirectory }, error => { if (error) failure = 'startup_failed' })
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const current = await verifiedState(directory)
      if (current) return await opened(current, false)
      if (failure && failure !== 'service_locked') throw new Error(failure)
      await delay(75)
    }
    throw new Error(failure ?? 'startup_timeout')
  } finally {
    // Never kill a process discovered via a PID file or a contended port.
    // The child can finish starting if this launcher is closed early.
    if (child.connected) child.disconnect()
    child.unref()
  }
}

export async function quitInstance(directory, { timeoutMs = 8000 } = {}) {
  const current = await verifiedState(directory)
  if (!current) throw new Error('instance_unavailable')
  await callControl(current.state, 'quit')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const saved = await readInstance(directory)
    if (!saved || saved.instanceId !== current.state.instanceId) return { status: 'stopped' }
    await delay(75)
  }
  throw new Error('shutdown_failed')
}
