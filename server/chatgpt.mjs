import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRemoteJWKSet } from 'jose'
import { authorization, callbackGrant, issuer, resource, validateTokens, syntheticRequest, readProbeStream } from './chatgpt-protocol.mjs'
import { createSecureStore } from './secure-store.mjs'
import { isAnalysisModel, analysisRequest, requestByteLimit } from '../shared/analysis-policy.mjs'
import { responseEvents } from '../shared/response-events.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const random = () => randomBytes(32).toString('base64url')
const safeErrors = {
  service_locked: 'Another Echo connection service is running. Close the other dev or preview server, then retry. Do not delete lock files while Echo is running.',
  service_lock_unavailable: 'Echo could not acquire its local connection lock. Ensure flock (util-linux) is installed and the local state directory is writable.',
  secure_store_unavailable: 'Unlock your OS credential store. Linux also requires Secret Service and secret-tool. Secure credential storage is required.',
  connection_failed: 'ChatGPT could not complete the connection. Try signing in again.',
  unauthorized: 'Continue with ChatGPT to connect this browser.',
  busy: 'A connection operation is already running. Try again when it finishes.',
  invalid_request: 'This request could not be accepted. Refresh Echo and try again.',
  probe_failed: 'The connection check did not complete. Reconnect or check your ChatGPT plan limits.',
  expired: 'Your ChatGPT session needs to be renewed. Continue with ChatGPT again.',
  invalid_analysis: 'The analysis context is incomplete or changed. Review the selection again.',
  invalid_image: 'A selected image could not be accepted. Review its format and size.',
  context_too_large: 'This request exceeds Echo’s 24 MB transfer limit. Nothing was sent to OpenAI. Choose a narrower context, fewer images, or a new discussion.',
  image_limit: 'This discussion exceeds Echo’s eight-image limit. Nothing was sent to OpenAI. Select fewer images or start a new discussion.',
  model_unavailable: 'No supported analysis model is available on this ChatGPT account.',
  duplicate_request: 'This send was already submitted. Review before trying a new request.',
  quota: 'ChatGPT plan usage is unavailable or temporarily rate-limited. Review your plan capacity in ChatGPT settings before retrying.',
  provider_context: 'OpenAI reported that this request exceeds the selected model’s context capacity. The request was sent; Echo did not shorten it. Choose a narrower context or start a new discussion to leave earlier context behind.',
}

export function createChatGPTService({ origin, store = createSecureStore(), request = fetch,
  keySet = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)), verify = validateTokens } = {}) {
  const expected = new URL(origin)
  if (expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1') throw new Error('Loopback origin required')
  const cookieName = `echo_chatgpt_${expected.port || '80'}`
  const localOrigin = `http://localhost${expected.port ? `:${expected.port}` : ''}`
  const allowedOrigins = new Set([origin, localOrigin])
  const allowedHosts = new Set([expected.host, new URL(localOrigin).host])
  const attempts = new Map()
  let busy = false
  let idle = Promise.resolve()
  let closed = false
  let closing
  let cancellationEpoch = 0
  const active = new Set()
  const sent = new Map()

  function cookie(req) {
    return (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? ''
  }
  function setCookie(res, value, seconds = 2_592_000) {
    res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}`)
  }
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  function fail(code) { throw new Error(code) }
  async function exclusive(fn, wait = false) {
    if (wait) await idle
    if (busy) fail('busy')
    busy = true
    let release
    idle = new Promise(resolve => { release = resolve })
    try { return await fn() } finally { busy = false; release() }
  }
  async function authorized(req) {
    const token = cookie(req)
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail('unauthorized')
    const record = await store.read()
    if (!record?.credential || record.sessionHash !== hash(token) || !Number.isFinite(record.sessionExpires) || record.sessionExpires < Date.now()) fail('unauthorized')
    return record
  }
  async function providerJson(url, options = {}) {
    const response = await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) })
    if (!response.ok) fail(response.status === 401 ? 'expired' : 'connection_failed')
    return response.json()
  }
  async function refresh(record) {
    const saved = record.credential
    if (saved.expires > Date.now() + 60_000) return record
    const renewed = await providerJson(`${issuer}/api/accounts/oauth/token`, {
      method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: saved.clientId,
        refresh_token: saved.tokens.refresh_token, resource }),
    })
    const tokens = { ...saved.tokens, ...renewed }
    if (renewed.id_token) await verify(tokens, saved.clientId, keySet, { subject: saved.subject })
    if (typeof renewed.access_token !== 'string' || !renewed.access_token || !Number.isFinite(renewed.expires_in) || renewed.expires_in <= 0 ||
        tokens.token_type?.toLowerCase() !== 'bearer' || !tokens.scope?.split(/\s+/).includes('chatgpt.tokens.use.direct') ||
        typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) fail('expired')
    const updated = { ...record, credential: { ...saved, tokens, expires: Date.now() + renewed.expires_in * 1000 } }
    await store.write(updated)
    return updated
  }
  async function models(record) {
    const catalog = await providerJson(`${resource}/models`, { headers: { Authorization: `Bearer ${record.credential.tokens.access_token}` } })
    return (catalog.models ?? []).filter(model => model.visibility === 'list' && isAnalysisModel(model.slug))
      .map(model => ({ id: model.slug, name: typeof model.display_name === 'string' ? model.display_name : model.slug }))
  }
  async function completeLogin(req, res, attempt) {
    const key = hash(cookie(req))
    if (attempts.get(key) !== attempt || !attempt.credential || Date.now() > attempt.expires) fail('invalid_request')
    const session = random()
    await store.write({ hostId: attempt.hostId, credential: attempt.credential,
      sessionHash: hash(session), sessionExpires: Date.now() + 2_592_000_000 })
    attempts.delete(key)
    setCookie(res, session)
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('ChatGPT is connected. Close this tab and return to Echo. No conversation has been sent.')
  }
  async function readAnalysis(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) fail('invalid_analysis')
    if (Number(req.headers['content-length'] ?? 0) > requestByteLimit) fail('context_too_large')
    const chunks = []
    let size = 0
    req.setTimeout(15_000, () => req.destroy())
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > requestByteLimit) fail('context_too_large')
        chunks.push(chunk)
      }
    } finally { req.setTimeout(0) }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('invalid_analysis') }
  }
  function providerError(code) {
    if (['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable', 'rate_limit_exceeded', 'insufficient_quota'].includes(code)) return 'quota'
    if (['context_length_exceeded', 'context_window_exceeded'].includes(code)) return 'provider_context'
    return 'provider_failure'
  }

  async function handle(req, res, next = () => { res.writeHead(404).end() }) {
    const path = req.url?.split('?')[0]
    if (!path?.startsWith('/api/chatgpt/') && path !== '/auth/callback' && path !== '/auth/complete') return next()
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    try {
      if (closed || !allowedHosts.has(req.headers.host) || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || (req.url?.length ?? 0) > 16_384) fail('invalid_request')
      const browserOrigin = `http://${req.headers.host}`
      for (const [key, attempt] of attempts) if (Date.now() > attempt.expires) attempts.delete(key)
      if (path === '/auth/complete') {
        if (req.method !== 'GET') fail('invalid_request')
        const params = new URL(req.url, browserOrigin).searchParams
        const attempt = attempts.get(hash(cookie(req)))
        if (!attempt || attempt.browserOrigin !== browserOrigin || params.getAll('state').length !== 1 || params.get('state') !== attempt.state) fail('invalid_request')
        await exclusive(() => completeLogin(req, res, attempt))
        return
      }
      if (path === '/auth/callback') {
        if (req.method !== 'GET' || req.headers.host !== expected.host) fail('invalid_request')
        const url = new URL(req.url, origin)
        const entry = [...attempts].find(([, value]) => value.state === url.searchParams.get('state'))
        const [pendingKey, attempt] = entry ?? []
        if (!attempt || (attempt.browserOrigin === origin && hash(cookie(req)) !== pendingKey)) fail('invalid_request')
        await exclusive(async () => {
          const grant = callbackGrant(url.searchParams, attempt)
          const tokens = await providerJson(`${issuer}/api/accounts/oauth/token`, { method: 'POST', body: grant.body })
          const credential = await verify(tokens, grant.clientId, keySet, { nonce: attempt.nonce, subject: attempt.subject })
          if (closed || attempts.get(pendingKey) !== attempt) fail('connection_failed')
          attempt.credential = credential
          if (attempt.browserOrigin === origin) await completeLogin(req, res, attempt)
          else {
            // Return to the initiating hostname before checking its HttpOnly cookie.
            // No code or provider token is forwarded. State alone cannot pair a browser.
            res.writeHead(303, { Location: `${attempt.browserOrigin}/auth/complete?${new URLSearchParams({ state: attempt.state })}` })
            res.end()
          }
        })
        return
      }
      if (req.headers['x-echo-request'] !== '1' || (req.headers.origin && req.headers.origin !== browserOrigin) || !allowedOrigins.has(browserOrigin) ||
          (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) ||
          (req.method !== 'GET' && req.headers.origin !== browserOrigin)) fail('invalid_request')
      if (path !== '/api/chatgpt/analyze' && (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'])) fail('invalid_request')
      if (req.method === 'GET' && path === '/api/chatgpt/status') {
        if (!cookie(req) || attempts.has(hash(cookie(req)))) {
          json(res, 200, { state: attempts.has(hash(cookie(req))) ? 'connecting' : 'disconnected' }); return
        }
        try {
          await authorized(req)
          json(res, 200, { state: 'connected' })
        } catch (error) {
          if (error.message !== 'unauthorized') throw error
          json(res, 200, { state: 'disconnected' })
        }
        return
      }
      if (req.method === 'POST' && path === '/api/chatgpt/login') {
        await exclusive(async () => {
          if (attempts.size >= 8) fail('busy')
          const record = await store.read() ?? { hostId: `urn:uuid:${randomUUID()}` }
          await store.write(record)
          const attempt = authorization(record.hostId, `${origin}/auth/callback`, record.credential?.clientId)
          attempt.subject = record.credential?.subject
          attempt.hostId = record.hostId
          attempt.browserOrigin = browserOrigin
          // Signing in also pairs this browser. Always require deliberate consent.
          attempt.url.searchParams.set('prompt', 'consent')
          const pending = random()
          attempts.set(hash(pending), attempt)
          setCookie(res, pending, 300)
          json(res, 200, { url: attempt.url.toString() })
        })
        return
      }
      if (req.method === 'POST' && path === '/api/chatgpt/cancel-login') {
        attempts.delete(hash(cookie(req)))
        setCookie(res, '', 0)
        json(res, 200, { state: 'disconnected' }); return
      }
      if (req.method === 'POST' && path === '/api/chatgpt/disconnect') {
        await authorized(req)
        cancellationEpoch++
        for (const controller of active) controller.abort()
        await exclusive(async () => {
          const record = await authorized(req)
          for (const controller of active) controller.abort()
          attempts.clear()
          await store.write({ hostId: record.hostId })
          const remaining = await store.read()
          if (remaining?.credential || remaining?.sessionHash) fail('secure_store_unavailable')
          setCookie(res, '', 0)
          json(res, 200, { state: 'disconnected' })
        }, true)
        return
      }
      if (req.method === 'POST' && path === '/api/chatgpt/check') {
        await exclusive(async () => {
          const record = await refresh(await authorized(req))
          const available = await models(record)
          if (!available.length) fail('model_unavailable')
          const controller = new AbortController()
          active.add(controller)
          const timeout = setTimeout(() => controller.abort(), 120_000)
          const stop = () => { if (!res.writableEnded) controller.abort() }
          res.once('close', stop)
          try {
            const response = await request(`${resource}/responses`, { method: 'POST', redirect: 'error', signal: controller.signal,
              headers: { Authorization: `Bearer ${record.credential.tokens.access_token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(syntheticRequest(available[0].id)) })
            if (!await readProbeStream(response)) fail('probe_failed')
            json(res, 200, { state: 'connected', checked: true })
          } finally { clearTimeout(timeout); active.delete(controller); res.off('close', stop) }
        })
        return
      }
      if (req.method === 'GET' && path === '/api/chatgpt/models') {
        await exclusive(async () => {
          const record = await refresh(await authorized(req))
          const available = await models(record)
          json(res, 200, { models: available })
        })
        return
      }
      if (req.method === 'POST' && path === '/api/chatgpt/analyze') {
        await exclusive(async () => {
          const epoch = cancellationEpoch
          let record = await authorized(req)
          const payload = await readAnalysis(req)
          let body
          try { body = analysisRequest(payload) } catch (error) { fail(Object.hasOwn(safeErrors, error.message) ? error.message : 'invalid_analysis') }
          if (hash(JSON.stringify(payload.sourceParts)) !== payload.contextVersion) fail('invalid_analysis')
          for (const turn of [...payload.history, payload.turn]) for (const image of turn.images) {
            const bytes = Buffer.from(image.dataUrl.slice('data:image/png;base64,'.length), 'base64')
            if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
                bytes.readUInt32BE(16) !== image.width || bytes.readUInt32BE(20) !== image.height) fail('invalid_image')
          }
          record = await refresh(record)
          if (!(await models(record)).some(model => model.id === payload.model)) fail('model_unavailable')
          if (res.destroyed || closed || epoch !== cancellationEpoch) {
            if (!res.destroyed) json(res, 409, { error: 'Analysis was canceled before it was sent to OpenAI.' })
            return
          }
          for (const [id, time] of sent) if (Date.now() - time > 1_800_000) sent.delete(id)
          if (sent.has(payload.requestId)) fail('duplicate_request')
          if (sent.size >= 1000) fail('busy')
          sent.set(payload.requestId, Date.now())
          const controller = new AbortController()
          active.add(controller)
          const timeout = setTimeout(() => controller.abort(), 180_000)
          const stop = () => { if (!res.writableEnded) controller.abort() }
          res.once('close', stop)
          let completed = false
          let characters = 0
          const emit = event => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`) }
          try {
            const response = await request(`${resource}/responses`, { method: 'POST', redirect: 'error', signal: controller.signal,
              headers: { Authorization: `Bearer ${record.credential.tokens.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            if (!response.ok || !response.body) {
              if (response.status === 401) fail('expired')
              if (response.status === 429) fail('quota')
              // Interpret only structured codes; provider messages can contain private input.
              try { const error = await response.json(); if (providerError(error.error?.code) === 'provider_context') fail('provider_context') }
              catch (error) { if (error.message === 'provider_context') throw error }
              throw new Error('provider_failure')
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' })
            for await (const event of responseEvents(response.body)) {
              if (event.item?.type && /(?:call|compaction)/.test(event.item.type)) throw new Error('unexpected_capability')
              if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
                characters += event.delta.length
                if (characters > 500_000) throw new Error('response_limit')
                emit({ type: 'delta', delta: event.delta })
              }
              if (event.type === 'response.refusal.delta' && typeof event.delta === 'string') { characters += event.delta.length; emit({ type: 'delta', delta: event.delta }) }
              if (event.type === 'response.completed') { completed = true; break }
              if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) throw new Error(providerError(event.response?.error?.code ?? event.code))
            }
            if (!completed || !characters) throw new Error('interrupted')
            emit({ type: 'complete' })
            res.end()
          } catch (error) {
            const message = safeErrors[error.message] ?? 'The response did not finish. Your question is preserved. A retry may repeat processing and plan usage.'
            if (res.headersSent) { emit({ type: 'failed', message }); res.end() }
            else json(res, 503, { error: message, code: Object.hasOwn(safeErrors, error.message) ? error.message : 'provider_failure' })
          } finally { clearTimeout(timeout); active.delete(controller); res.off('close', stop) }
        })
        return
      }
      json(res, 404, { error: 'This connection action is unavailable.' })
    } catch (error) {
      const code = Object.hasOwn(safeErrors, error?.message) ? error.message : 'connection_failed'
      if (!res.headersSent) json(res, code === 'unauthorized' ? 401 : code === 'invalid_request' ? 403 : code === 'busy' ? 409 : 503, { error: safeErrors[code], code })
      else res.end()
    }
  }
  async function prepareJob(req, payload) {
    return exclusive(async () => {
      if (closed || req.headers.host !== expected.host || req.headers.origin !== origin || req.headers['x-echo-request'] !== '1') fail('invalid_request')
      const epoch = cancellationEpoch
      let record = await authorized(req)
      const body = analysisRequest(payload)
      if (hash(JSON.stringify(payload.sourceParts)) !== payload.contextVersion) fail('invalid_analysis')
      for (const turn of [...payload.history, payload.turn]) for (const image of turn.images) {
        const bytes = Buffer.from(image.dataUrl.slice('data:image/png;base64,'.length), 'base64')
        if (bytes.length < 33 || bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii',12,16) !== 'IHDR' ||
            bytes.readUInt32BE(16) !== image.width || bytes.readUInt32BE(20) !== image.height) fail('invalid_image')
      }
      record = await refresh(record)
      if (!(await models(record)).some(model => model.id === payload.model)) fail('model_unavailable')
      const providerAccount = hash(JSON.stringify([issuer, record.credential.subject, record.credential.clientId]))
      let used = false
      return { providerAccount,
        async run({ signal, onEvent }) {
          if (used) fail('duplicate_request')
          used = true
          return exclusive(async () => {
            if (closed || epoch !== cancellationEpoch || signal.aborted) fail('expired')
            record = await refresh(await authorized(req))
            if (hash(JSON.stringify([issuer, record.credential.subject, record.credential.clientId])) !== providerAccount) fail('unauthorized')
            const controller = new AbortController()
            active.add(controller)
            const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(180_000)])
            let characters = 0, completed = false
            try {
              const response = await request(`${resource}/responses`, { method: 'POST', redirect: 'error', signal: combined,
                headers: { Authorization: `Bearer ${record.credential.tokens.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
              if (!response.ok || !response.body) {
                if (response.status === 401) fail('expired')
                if (response.status === 429) fail('quota')
                let code
                try { code = (await response.json()).error?.code } catch { /* Do not propagate provider response text. */ }
                fail(providerError(code))
              }
              for await (const event of responseEvents(response.body)) {
                if (event.item?.type && /(?:call|compaction)/.test(event.item.type)) fail('provider_failure')
                if (['response.output_text.delta','response.refusal.delta'].includes(event.type) && typeof event.delta === 'string') {
                  characters += event.delta.length
                  if (characters > 500_000) fail('provider_failure')
                  await onEvent({ type: 'delta', delta: event.delta })
                }
                if (event.type === 'response.completed') { completed = true; break }
                if (['response.failed','response.incomplete','error'].includes(event.type)) fail(providerError(event.response?.error?.code ?? event.code))
              }
              if (!completed || !characters) fail('provider_failure')
              await onEvent({ type: 'complete' })
            } finally { active.delete(controller) }
          }, true)
        },
      }
    })
  }
  return { handle, prepareJob, async currentAccount(req) { const record = await authorized(req); return hash(JSON.stringify([issuer, record.credential.subject, record.credential.clientId])) }, close() {
    closing ??= (async () => {
      closed = true; cancellationEpoch++; attempts.clear(); for (const controller of active) controller.abort()
      await idle
      await store.close?.()
    })()
    return closing
  } }
}
