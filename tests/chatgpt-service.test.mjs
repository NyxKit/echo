import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { createChatGPTService } from '../server/chatgpt.mjs'
import { createHash, randomUUID } from 'node:crypto'

const cleanup = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function fixture({ locked = false, catalog = [{ slug: 'gpt-6.1-sol', visibility: 'list', display_name: 'Synthetic model' }] } = {}) {
  let record
  const store = {
    read: vi.fn(async () => { if (locked) throw new Error('secure_store_unavailable'); return structuredClone(record) }),
    write: vi.fn(async value => { if (locked) throw new Error('secure_store_unavailable'); record = structuredClone(value) }),
  }
  const provider = vi.fn(async url => {
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' })
    if (url.endsWith('/models')) return Response.json({ models: catalog })
    return new Response('data: {"type":"response.output_text.delta","delta":"amber cobalt willow"}\n\ndata: {"type":"response.completed"}\n\n')
  })
  const verify = vi.fn(async (tokens, clientId) => ({ clientId, subject: 'synthetic-account', tokens: {
    ...tokens, token_type: 'Bearer', scope: 'chatgpt.tokens.use.direct', expires_in: 3600,
  }, expires: Date.now() + 3_600_000 }))
  let service
  let responseClosed
  const analysisClosed = new Promise(resolve => { responseClosed = resolve })
  const server = createServer((req, res) => {
    if (req.url === '/api/chatgpt/analyze') res.once('close', responseClosed)
    void service.handle(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  service = createChatGPTService({ origin, store, request: provider, verify })
  cleanup.push(async () => { await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const call = (path, { method = 'POST', cookie = '', headers = {}, ...options } = {}) => fetch(`${origin}${path}`, {
    method, headers: { Origin: origin, 'X-Echo-Request': '1', Cookie: cookie, ...headers }, ...options,
  })
  const localhost = (path, cookie = '', method = 'POST') => new Promise((resolve, reject) => {
    const host = `localhost:${server.address().port}`
    const req = httpRequest(`${origin}${path}`, { method, headers: { Host: host, Origin: `http://${host}`, 'X-Echo-Request': '1', Cookie: cookie } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })))
    })
    req.on('error', reject)
    req.end()
  })
  async function login() {
    const response = await call('/api/chatgpt/login')
    const cookie = response.headers.get('set-cookie').split(';')[0]
    const { url } = await response.json()
    const callback = await call(`/auth/callback?${new URLSearchParams({ state: new URL(url).searchParams.get('state'), code: 'synthetic-code', client_id: 'oaiapp_synthetic' })}`, { method: 'GET', cookie })
    expect(callback.status).toBe(200)
    return callback.headers.get('set-cookie').split(';')[0]
  }
  return { call, localhost, login, store, provider, verify, origin, analysisClosed, get record() { return record },
    async restart() { await service.close(); service = createChatGPTService({ origin, store, request: provider, verify }) },
  }
}

describe('browser-owned ChatGPT connection', () => {
  function payload() {
    const sourceParts = [JSON.stringify({ messages: [{ sender_name: 'Example', content: 'Synthetic content only' }], retained: true })]
    return { requestId: randomUUID(), model: 'gpt-6.1-sol', sourceParts,
      contextVersion: createHash('sha256').update(JSON.stringify(sourceParts)).digest('hex'),
      sourceVersion: createHash('sha256').update(JSON.stringify(sourceParts)).digest('hex'), history: [],
      turn: { question: 'Explain this synthetic passage', focus: ['p1:m1'], context: { scope: 'full' }, images: [], excluded: [] } }
  }
  it('does not read credentials or call OpenAI merely to show a disconnected status', async () => {
    const app = await fixture()
    expect(await (await app.call('/api/chatgpt/status', { method: 'GET' })).json()).toEqual({ state: 'disconnected' })
    expect(app.store.read).not.toHaveBeenCalled()
    expect(app.provider).not.toHaveBeenCalled()
  })

  it('uses the same live account catalog for the picker, connection check, and analysis', async () => {
    const app = await fixture({ catalog: [
      { slug: 'synthetic-account-model', visibility: 'list', display_name: 'Account model' },
      { slug: 'hidden-model', visibility: 'hide', display_name: 'Hidden' },
      { slug: 'synthetic-other-model', visibility: 'list', display_name: 'Other model' },
    ] })
    const cookie = await app.login()
    const listed = await app.call('/api/chatgpt/models', { method: 'GET', cookie })
    expect(await listed.json()).toEqual({ models: [
      { id: 'synthetic-account-model', name: 'Account model' },
      { id: 'synthetic-other-model', name: 'Other model' },
    ] })
    expect((await app.call('/api/chatgpt/check', { cookie })).status).toBe(200)
    const analysis = payload(); analysis.model = 'synthetic-account-model'
    const result = await app.call('/api/chatgpt/analyze', { cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(analysis) })
    expect(result.status).toBe(200)
    await result.text()
    const requests = app.provider.mock.calls.filter(([url]) => url.endsWith('/responses'))
    expect(requests).toHaveLength(2)
    expect(requests.map(([, options]) => JSON.parse(options.body).model)).toEqual(['synthetic-account-model', 'synthetic-account-model'])
    for (const unavailable of ['hidden-model', 'not-in-the-account-catalog']) {
      const rejected = payload(); rejected.model = unavailable
      const response = await app.call('/api/chatgpt/analyze', { cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rejected) })
      expect((await response.json()).code).toBe('model_unavailable')
    }
    expect(app.provider.mock.calls.filter(([url]) => url.endsWith('/responses'))).toHaveLength(2)
  })

  it('rejects wrong hosts, cross-origin requests and requests without the CSRF header', async () => {
    const app = await fixture()
    const wrongHost = await new Promise(resolve => {
      const req = httpRequest(`${app.origin}/api/chatgpt/login`, { method: 'POST', headers: { Host: 'evil.invalid', Origin: app.origin, 'X-Echo-Request': '1' } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode))
      })
      req.end()
    })
    expect(wrongHost).toBe(403)
    for (const headers of [{ Origin: 'https://evil.invalid' }, { 'X-Echo-Request': '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      expect((await app.call('/api/chatgpt/login', { headers })).status, JSON.stringify(headers)).toBe(403)
    }
    expect(app.store.read).not.toHaveBeenCalled()
  })

  it('requires the initiating browser cookie and state, rotates the session, and keeps credentials out of responses', async () => {
    const app = await fixture()
    const response = await app.call('/api/chatgpt/login')
    const pending = response.headers.get('set-cookie').split(';')[0]
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax')
    const { url } = await response.json()
    expect(new URL(url).searchParams.get('prompt')).toBe('consent')
    const callbackPath = `/auth/callback?${new URLSearchParams({ state: new URL(url).searchParams.get('state'), code: 'synthetic-code', client_id: 'oaiapp_synthetic' })}`
    expect((await app.call(callbackPath, { method: 'GET' })).status).toBe(403)
    expect(app.provider).not.toHaveBeenCalled()
    const callback = await app.call(callbackPath, { method: 'GET', cookie: pending })
    const session = callback.headers.get('set-cookie').split(';')[0]
    expect(session).not.toBe(pending)
    expect(await callback.text()).not.toContain('synthetic-access')
    expect((await app.call(callbackPath, { method: 'GET', cookie: pending })).status).toBe(403)
    expect(await (await app.call('/api/chatgpt/status', { method: 'GET', cookie: pending })).json()).toEqual({ state: 'disconnected' })
    const status = await app.call('/api/chatgpt/status', { method: 'GET', cookie: session })
    expect(status.headers.get('cache-control')).toBe('no-store')
    expect(await status.json()).toEqual({ state: 'connected' })
    expect(app.provider).toHaveBeenCalledTimes(1)
  })

  it('checks only fixed synthetic content after explicit action and requires a session', async () => {
    const app = await fixture()
    expect((await app.call('/api/chatgpt/check')).status).toBe(401)
    const cookie = await app.login()
    expect((await app.call('/api/chatgpt/check', { cookie, body: 'arbitrary-content' })).status).toBe(403)
    expect(await (await app.call('/api/chatgpt/check', { cookie })).json()).toEqual({ state: 'connected', checked: true })
    const request = app.provider.mock.calls.find(([url]) => url.endsWith('/responses'))[1]
    expect(JSON.parse(request.body).input[0].content).toContain('"synthetic":true')
    expect(JSON.parse(request.body).tools).toEqual([])
  })

  it('removes app credentials on disconnect and invalidates the browser session', async () => {
    const app = await fixture()
    const cookie = await app.login()
    const hostId = app.record.hostId
    expect((await app.call('/api/chatgpt/disconnect', { cookie })).status).toBe(200)
    expect(app.record).toEqual({ hostId })
    expect((await app.call('/api/chatgpt/check', { cookie })).status).toBe(401)
  })

  it('fails closed if secure storage is unavailable and does not start OAuth', async () => {
    const app = await fixture({ locked: true })
    const result = await app.call('/api/chatgpt/login')
    expect(result.status).toBe(503)
    expect((await result.json()).code).toBe('secure_store_unavailable')
    expect(app.provider).not.toHaveBeenCalled()
  })

  it('canceling sign-in invalidates the pending callback without accessing a credential', async () => {
    const app = await fixture()
    const result = await app.call('/api/chatgpt/login')
    const cookie = result.headers.get('set-cookie').split(';')[0]
    const { url } = await result.json()
    await app.call('/api/chatgpt/cancel-login', { cookie })
    const callback = `/auth/callback?${new URLSearchParams({ state: new URL(url).searchParams.get('state'), code: 'synthetic-code', client_id: 'oaiapp_synthetic' })}`
    expect((await app.call(callback, { method: 'GET', cookie })).status).toBe(403)
    expect(app.provider).not.toHaveBeenCalled()
  })

  it('returns from the required 127.0.0.1 callback to localhost and pairs only the initiating browser', async () => {
    const app = await fixture()
    const result = await app.localhost('/api/chatgpt/login')
    expect(result.status).toBe(200)
    const cookie = result.headers.get('set-cookie').split(';')[0]
    const { url } = await result.json()
    const authorization = new URL(url)
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${app.origin}/auth/callback`)
    const state = authorization.searchParams.get('state')
    const callback = await app.call(`/auth/callback?${new URLSearchParams({ state, code: 'synthetic-code', client_id: 'oaiapp_synthetic' })}`, { method: 'GET', redirect: 'manual' })
    expect(callback.status).toBe(303)
    expect(app.record.credential).toBeUndefined()
    const complete = new URL(callback.headers.get('location'))
    expect(complete.hostname).toBe('localhost')
    expect([...complete.searchParams.keys()]).toEqual(['state'])
    expect((await app.localhost(complete.pathname + complete.search, '', 'GET')).status).toBe(403)
    const paired = await app.localhost(complete.pathname + complete.search, cookie, 'GET')
    expect(paired.status).toBe(200)
    const session = paired.headers.get('set-cookie').split(';')[0]
    expect(await (await app.localhost('/api/chatgpt/status', session, 'GET')).json()).toEqual({ state: 'connected' })
    expect((await app.localhost(complete.pathname + complete.search, cookie, 'GET')).status).toBe(403)
  })

  it('streams a disclosed complete context only after an authenticated send and deduplicates dispatch', async () => {
    const app = await fixture()
    const cookie = await app.login()
    const data = payload()
    const options = { cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
    const result = await app.call('/api/chatgpt/analyze', options)
    expect(result.status).toBe(200)
    expect(await result.text()).toContain('"type":"complete"')
    const request = app.provider.mock.calls.find(([url]) => url.endsWith('/responses'))[1]
    expect(JSON.parse(JSON.parse(request.body).input[0].content[0].text).sourceParts[0].json).toEqual(JSON.parse(data.sourceParts[0]))
    const repeated = await app.call('/api/chatgpt/analyze', options)
    expect((await repeated.json()).code).toBe('duplicate_request')
    expect(app.provider.mock.calls.filter(([url]) => url.endsWith('/responses'))).toHaveLength(1)
  })

  it('rejects changed prepared-context digests and invalid images before any inference', async () => {
    const app = await fixture()
    const cookie = await app.login()
    const data = payload(); data.contextVersion = 'a'.repeat(64)
    const changed = await app.call('/api/chatgpt/analyze', { cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    expect((await changed.json()).code).toBe('invalid_analysis')
    const badImage = payload(); badImage.turn.images = [{ reference: 'p1:m1', dataUrl: 'data:image/png;base64,c3ludGhldGlj', width: 100, height: 100 }]
    const image = await app.call('/api/chatgpt/analyze', { cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(badImage) })
    expect((await image.json()).code).toBe('invalid_image')
    expect(app.provider.mock.calls.filter(([url]) => url.endsWith('/responses'))).toHaveLength(0)
  })
  it('sends only the reviewed sparse source and distinguishes provider context rejection from local limits', async () => {
    const app = await fixture()
    const cookie = await app.login()
    const data = payload()
    data.sourceParts = ['{"messages":{"42":{"content":"Only this synthetic message","id":9007199254740993123}}}']
    data.contextVersion = createHash('sha256').update(JSON.stringify(data.sourceParts)).digest('hex')
    data.turn.focus = ['p1:m43']
    data.turn.context = { scope: 'selected', references: ['p1:m43'] }
    app.provider.mockImplementation(async url => url.endsWith('/models')
      ? Response.json({ models: [{ slug: data.model, visibility: 'list' }] })
      : Response.json({ error: { code: 'context_length_exceeded', message: 'Never expose synthetic provider detail' } }, { status: 400 }))
    const response = await app.call('/api/chatgpt/analyze', { cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    const error = await response.json()
    expect(error.code).toBe('provider_context')
    expect(error.error).toContain('request was sent')
    expect(error.error).not.toContain('provider detail')
    const request = app.provider.mock.calls.findLast(([url]) => url.endsWith('/responses'))[1]
    const text = JSON.parse(request.body).input[0].content[0].text
    expect(text).toContain('9007199254740993123')
    // oxlint-disable-next-line no-loss-of-precision -- Assert the deliberately lossy JSON.parse result.
    expect(JSON.parse(text).sourceParts[0].json.messages).toEqual({ 42: { content: 'Only this synthetic message', id: 9007199254740993123 } })
  })

  it('does not expose raw provider errors or label partial responses complete', async () => {
    const app = await fixture()
    const cookie = await app.login()
    app.provider.mockImplementation(async url => url.endsWith('/models')
      ? Response.json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] })
      : new Response('data: {"type":"response.output_text.delta","delta":"Partial synthetic answer"}\n\ndata: {"type":"response.failed","response":{"error":{"message":"synthetic-private-diagnostic"}}}\n\n'))
    const result = await app.call('/api/chatgpt/analyze', { cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) })
    const text = await result.text()
    expect(text).toContain('"type":"failed"')
    expect(text).not.toContain('"type":"complete"')
    expect(text).not.toContain('synthetic-private-diagnostic')
  })

  it('reuses the browser session after service restart and serializes rotating token refresh', async () => {
    const app = await fixture()
    const cookie = await app.login()
    await app.restart()
    expect(await (await app.call('/api/chatgpt/status', { method: 'GET', cookie })).json()).toEqual({ state: 'connected' })
    app.record.credential.expires = 0
    let began
    let release
    const started = new Promise(resolve => { began = resolve })
    const blocked = new Promise(resolve => { release = resolve })
    app.provider.mockImplementation(async (url, options) => {
      if (url.endsWith('/oauth/token')) {
        expect(options.body.get('client_id')).toBe('oaiapp_synthetic')
        expect(options.body.get('grant_type')).toBe('refresh_token')
        began(); await blocked
        return Response.json({ access_token: 'synthetic-renewed', refresh_token: 'synthetic-rotated', expires_in: 3600 })
      }
      return Response.json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] })
    })
    const first = app.call('/api/chatgpt/models', { cookie, method: 'GET' })
    await started
    expect((await app.call('/api/chatgpt/models', { cookie, method: 'GET' })).status).toBe(409)
    release()
    expect((await first).status).toBe(200)
    expect(app.record.credential.tokens.refresh_token).toBe('synthetic-rotated')
    expect(app.record.credential.tokens.access_token).toBe('synthetic-renewed')
  })

  it('aborts the provider when the browser cancels a streamed response', async () => {
    const app = await fixture()
    const cookie = await app.login()
    let aborted = false
    app.provider.mockImplementation(async (url, options) => {
      if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] })
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"Partial synthetic answer"}\n\n'))
        options.signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('synthetic-abort')) })
      } }))
    })
    const result = await app.call('/api/chatgpt/analyze', { cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) })
    const reader = result.body.getReader()
    await reader.read()
    await reader.cancel()
    await vi.waitFor(() => expect(aborted).toBe(true))
    reader.releaseLock()
  })

  it('does not dispatch private context if canceled during model discovery', async () => {
    const app = await fixture()
    const cookie = await app.login()
    let began
    let release
    const started = new Promise(resolve => { began = resolve })
    const blocked = new Promise(resolve => { release = resolve })
    app.provider.mockImplementation(async url => {
      if (url.endsWith('/models')) { began(); await blocked; return Response.json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] }) }
      throw new Error('unexpected-synthetic-dispatch')
    })
    const controller = new AbortController()
    const result = app.call('/api/chatgpt/analyze', { cookie, signal: controller.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) })
    result.catch(() => {})
    await started
    controller.abort()
    await expect(result).rejects.toThrow()
    await app.analysisClosed
    release()
    await vi.waitFor(async () => expect((await app.call('/api/chatgpt/models', { cookie, method: 'GET' })).status).toBe(200))
    expect(app.provider.mock.calls.filter(([url]) => url.endsWith('/responses'))).toHaveLength(0)
  })
})
