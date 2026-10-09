import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, request } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { startApplication } from '../server/application.mjs'
import { startInstance } from '../server/instance.mjs'
import { CONTROL_PATH, callControl, controlHeaders } from '../server/local-control.mjs'
import { newInstance, publishInstance, readInstance } from '../server/runtime-state.mjs'
import { createChatGPTService } from '../server/chatgpt.mjs'
import { instanceStatus, launch, quitInstance } from '../server/launcher.mjs'
import { openLibrary } from '../server/library/client.mjs'
import { SCHEMA_VERSION } from '../server/library/schema.mjs'

const cleanup = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'echo-synthetic-server-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'ui')
  const runtime = join(directory, 'runtime')
  await mkdir(join(root, 'assets'), { recursive: true })
  await mkdir(runtime, { mode: 0o700 })
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Synthetic Echo</title>')
  await writeFile(join(root, 'assets', 'app-test.js'), '/* synthetic build */')
  await writeFile(join(root, 'assets', 'app-test.css'), 'body {}')
  await writeFile(join(root, 'assets', 'app-test.js.map'), 'synthetic source map')
  await writeFile(join(root, 'unpublished.json'), '{"synthetic":true}')
  return { directory, root, runtime }
}

function http(origin, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(origin, { path, method, headers, agent: false }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function application(options = {}) {
  const files = await fixture()
  const state = newInstance(0)
  const close = vi.fn(async () => {})
  const service = { close, handle: vi.fn((_req, res) => res.writeHead(200).end('synthetic service')) }
  const app = await startApplication({ root: files.root, state, createService: () => service, ...options })
  cleanup.push(() => app.close().catch(() => {}))
  return { ...files, ...app, state, service }
}

describe('production application boundary', () => {
  it('serves only the built entry point and supported assets, with HEAD and private caching', async () => {
    const app = await application()
    const page = await http(app.origin, '/')
    expect(page.status).toBe(200)
    expect(page.text).toContain('Synthetic Echo')
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.headers['x-content-type-options']).toBe('nosniff')
    expect((await http(app.origin, '/assets/app-test.js')).headers['content-type']).toContain('text/javascript')
    expect((await http(app.origin, '/assets/app-test.css', { method: 'HEAD' })).text).toBe('')
    for (const path of ['/unpublished.json', '/assets/app-test.js.map', '/data/synthetic.json', '/server/chatgpt.mjs', '/.env',
      '/../unpublished.json', '/assets/../unpublished.json', '/assets/%2e%2e/unpublished.json', '/assets/app-test.js%00', '/unknown', '/assets/missing.js']) {
      expect((await http(app.origin, path)).status, path).toBe(404)
    }
    expect((await http(app.origin, '/', { method: 'POST' })).status).toBe(405)
    expect((await http(app.origin, '/', { headers: { 'Content-Length': '1' }, body: 'x' })).status).toBe(400)
  })

  it('refuses symlinked entry points, asset files and asset directories', async () => {
    const app = await application()
    await symlink(join(app.root, 'unpublished.json'), join(app.root, 'assets', 'linked.js'))
    expect((await http(app.origin, '/assets/linked.js')).status).toBe(404)
    await rm(join(app.root, 'assets'), { recursive: true })
    await mkdir(join(app.directory, 'other'))
    await writeFile(join(app.directory, 'other', 'hidden.js'), 'synthetic private file')
    await symlink(join(app.directory, 'other'), join(app.root, 'assets'))
    expect((await http(app.origin, '/assets/hidden.js')).status).toBe(404)
    await rm(join(app.root, 'index.html'))
    await symlink(join(app.root, 'unpublished.json'), join(app.root, 'index.html'))
    await expect(startApplication({ root: app.root, state: newInstance(0) })).rejects.toThrow('build_missing')
  })

  it('requires the exact loopback host and blocks foreign browser requests', async () => {
    const app = await application()
    for (const headers of [{ Host: 'evil.invalid' }, { Host: 'localhost:1234' }, { Origin: 'https://evil.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      expect((await http(app.origin, '/', { headers })).status).toBe(403)
    }
    expect((await http(app.origin, '//evil.invalid')).status).toBe(403)
  })

  it('requires signed control requests, rejects replay, and authenticates readiness', async () => {
    const app = await application()
    expect(await callControl(app.state)).toEqual({ version: 1, instanceId: app.state.instanceId, status: 'ready' })
    const path = `${CONTROL_PATH}status`
    expect((await http(app.origin, path)).status).toBe(403)
    const headers = controlHeaders(app.state, 'GET', path)
    expect((await http(app.origin, path, { headers })).status).toBe(200)
    expect((await http(app.origin, path, { headers })).status).toBe(403)
    const stale = controlHeaders(app.state, 'GET', path, { timestamp: String(Date.now() - 60_000) })
    expect((await http(app.origin, path, { headers: stale })).status).toBe(403)
    for (const extra of [{ Origin: app.origin }, { 'Sec-Fetch-Site': 'same-origin' }, { 'X-Echo-Proof': '0'.repeat(64) }]) {
      expect((await http(app.origin, path, { headers: { ...controlHeaders(app.state, 'GET', path), ...extra } })).status).toBe(403)
    }
    await expect(callControl({ ...app.state, secret: '0'.repeat(64) })).rejects.toThrow('instance_unavailable')
    expect((await http(app.origin, `${CONTROL_PATH}quit`, { method: 'POST', headers: controlHeaders(app.state, 'GET', path) })).status).toBe(403)
    expect((await callControl(app.state)).status).toBe('ready')
  })

  it('does not trust an unrelated responder or send it a reusable secret', async () => {
    const state = newInstance(0)
    let received
    const server = createServer((req, res) => { received = req.headers; res.end(JSON.stringify({ version: 1, instanceId: state.instanceId, status: 'ready' })) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise(resolve => server.close(resolve)))
    state.port = server.address().port
    await expect(callControl(state)).rejects.toThrow('instance_unavailable')
    expect(JSON.stringify(received)).not.toContain(state.secret)
  })

  it('rejects shutdown with a body and waits for asynchronous service cleanup', async () => {
    let finish
    const wait = new Promise(resolve => { finish = resolve })
    const onQuit = vi.fn()
    const app = await application({ onQuit, createService: () => ({ close: () => wait }) })
    const path = `${CONTROL_PATH}quit`
    expect((await http(app.origin, path, { method: 'POST', headers: { ...controlHeaders(app.state, 'POST', path), 'Content-Length': '1' }, body: 'x' })).status).toBe(403)
    expect((await callControl(app.state, 'quit')).status).toBe('stopping')
    expect(onQuit).toHaveBeenCalledOnce()
    expect((await http(app.origin, '/')).status).toBe(503)
    let closed = false
    const closing = app.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    finish()
    await closing
    expect(closed).toBe(true)
  })

  it('bounds a stalled shutdown and closes HTTP admission', async () => {
    const app = await application({ shutdownMs: 30, createService: () => ({ close: () => new Promise(() => {}) }) })
    await expect(app.close()).rejects.toThrow('shutdown_timeout')
    await expect(http(app.origin, '/')).rejects.toThrow()
  })

  it('preserves OAuth pairing through the production server with synthetic credentials only', async () => {
    let record
    const store = { read: vi.fn(async () => record), write: vi.fn(async value => { record = value }), close: vi.fn() }
    const provider = vi.fn(async () => Response.json({ access_token: 'synthetic-token' }))
    const app = await application({ createService: options => createChatGPTService({ ...options, store, request: provider, keySet: {},
      verify: async () => ({ subject: 'synthetic-subject', tokens: {}, expires: Date.now() + 60_000 }) }) })
    const headers = { Origin: app.origin, 'X-Echo-Request': '1' }
    const status = await http(app.origin, '/api/chatgpt/status', { headers })
    expect(JSON.parse(status.text).state).toBe('disconnected')
    expect(store.read).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()
    expect((await http(app.origin, '/api/chatgpt/login', { method: 'POST' })).status).toBe(403)
    const login = await http(app.origin, '/api/chatgpt/login', { method: 'POST', headers })
    const cookie = login.headers['set-cookie'][0].split(';')[0]
    const authorization = new URL(JSON.parse(login.text).url)
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${app.origin}/auth/callback`)
    const callback = `/auth/callback?${new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'synthetic-code', client_id: 'oaiapp_synthetic' })}`
    expect((await http(app.origin, callback)).status).toBe(403)
    const paired = await http(app.origin, callback, { headers: { Cookie: cookie } })
    expect(paired.status).toBe(200)
    expect(paired.text).not.toContain('synthetic-token')
    const pairedCookie = paired.headers['set-cookie'][0].split(';')[0]
    expect(JSON.parse((await http(app.origin, '/api/chatgpt/status', { headers: { ...headers, Cookie: pairedCookie } })).text).state).toBe('connected')
  })
})

describe.runIf(process.platform === 'linux')('Linux instance and detached launcher', () => {
  it('owns the library until shutdown without exposing it through static or unauthenticated routes', async () => {
    const files = await fixture()
    const libraryDirectory = join(files.directory, 'library')
    const instance = await startInstance({ directory: files.runtime, root: files.root, port: 0, libraryDirectory, createService: () => ({ close: async () => {} }) })
    cleanup.push(() => instance.close())
    await expect(openLibrary(libraryDirectory)).rejects.toThrow('service_locked')
    expect((await http(instance.origin, '/library.sqlite')).status).toBe(404)
    expect((await http(instance.origin, '/api/library/v1/conversations')).status).toBe(403)
    await instance.close()
    const library = await openLibrary(libraryDirectory)
    cleanup.push(() => library.close())
    expect((await library.status()).schemaVersion).toBe(SCHEMA_VERSION)
    expect((await library.status()).owner).toBeNull()
  })

  it('publishes private state, holds one lease across ports, and recovers stale state', async () => {
    const files = await fixture()
    await publishInstance(files.runtime, newInstance(12345))
    const instance = await startInstance({ directory: files.runtime, root: files.root, port: 0, createService: () => ({ close: async () => {} }) })
    cleanup.push(() => instance.close())
    const state = await readInstance(files.runtime)
    expect((await stat(join(files.runtime, 'instance.json'))).mode & 0o777).toBe(0o600)
    expect((await callControl(state)).status).toBe('ready')
    await expect(startInstance({ directory: files.runtime, root: files.root, port: 0 })).rejects.toThrow('service_locked')
    await instance.close()
    expect(await readInstance(files.runtime)).toBeUndefined()
    expect(await readFile(join(files.runtime, 'instance.lock', 'lease'), 'utf8')).toBe('')
    const restarted = await startInstance({ directory: files.runtime, root: files.root, createService: () => ({ close: async () => {} }) })
    cleanup.push(() => restarted.close())
    expect(restarted.origin).toBe(instance.origin)
    expect((await readInstance(files.runtime)).secret).not.toBe(state.secret)
  })

  it('reports a port collision, preserves stale state, and releases the failed startup lease', async () => {
    const files = await fixture()
    const unrelated = createServer((_req, res) => res.end('synthetic unrelated server'))
    await new Promise(resolve => unrelated.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise(resolve => unrelated.close(resolve)))
    const stale = newInstance(unrelated.address().port)
    await publishInstance(files.runtime, stale)
    await expect(startInstance({ directory: files.runtime, root: files.root })).rejects.toThrow('port_in_use')
    expect(await readInstance(files.runtime)).toEqual(stale)
    const instance = await startInstance({ directory: files.runtime, root: files.root, port: 0, createService: () => ({ close: async () => {} }) })
    cleanup.push(() => instance.close())
    expect(instance.origin).not.toContain(`:${stale.port}`)
  })

  it('rejects unsafe lifecycle files and never follows a state symlink', async () => {
    const files = await fixture()
    await writeFile(join(files.directory, 'other.json'), JSON.stringify(newInstance(12345)), { mode: 0o600 })
    await symlink(join(files.directory, 'other.json'), join(files.runtime, 'instance.json'))
    await expect(readInstance(files.runtime)).rejects.toThrow('state_unavailable')
    await rm(join(files.runtime, 'instance.json'))
    await writeFile(join(files.runtime, 'instance.json'), JSON.stringify(newInstance(12345)), { mode: 0o644 })
    await expect(readInstance(files.runtime)).rejects.toThrow('state_unavailable')
  })

  it('concurrent detached launches converge on one authenticated server, and explicit quit cleans up', async () => {
    const files = await fixture()
    // Publish a stale, ephemeral port to avoid using a real user's configured origin.
    const reserve = createServer()
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
    const port = reserve.address().port
    await new Promise(resolve => reserve.close(resolve))
    await publishInstance(files.runtime, newInstance(port))
    cleanup.push(async () => { if ((await instanceStatus(files.runtime)).status !== 'unavailable') await quitInstance(files.runtime) })
    const browser = vi.fn(async () => {})
    const options = { directory: files.runtime, root: files.root, browser }
    const results = await Promise.all([launch(options), launch(options)])
    expect(results[0].origin).toBe(results[1].origin)
    expect(browser).toHaveBeenCalledTimes(2)
    expect((await instanceStatus(files.runtime)).status).toBe('ready')
    // Closing a client connection does not close the detached server.
    expect((await http(results[0].origin, '/')).status).toBe(200)
    const again = await launch({ ...options, background: true })
    expect(again.reused).toBe(true)
    expect(browser).toHaveBeenCalledTimes(2)
    await expect(launch({ ...options, port: port === 65535 ? 65534 : port + 1 })).rejects.toThrow('port_mismatch')
    expect(await quitInstance(files.runtime)).toEqual({ status: 'stopped' })
    expect((await instanceStatus(files.runtime)).status).toBe('unavailable')
  }, 15_000)

  it('recovers after a server crash without trusting a saved PID or changing origin', async () => {
    const files = await fixture()
    const reserve = createServer()
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
    const port = reserve.address().port
    await new Promise(resolve => reserve.close(resolve))
    let child
    const options = { directory: files.runtime, root: files.root, background: true, port }
    cleanup.push(async () => { if ((await instanceStatus(files.runtime)).status !== 'unavailable') await quitInstance(files.runtime) })
    const first = await launch({ ...options, spawnHost: (...args) => { child = fork(...args); return child } })
    const previous = await readInstance(files.runtime)
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    expect((await instanceStatus(files.runtime)).status).toBe('unavailable')
    expect(await readInstance(files.runtime)).toEqual(previous)
    const recovered = await launch(options)
    expect(recovered.origin).toBe(first.origin)
    expect((await readInstance(files.runtime)).instanceId).not.toBe(previous.instanceId)
    expect((await readInstance(files.runtime)).secret).not.toBe(previous.secret)
    expect((await instanceStatus(files.runtime)).status).toBe('ready')
  }, 15_000)
})
