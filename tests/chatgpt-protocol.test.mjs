import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { generateKeyPair, SignJWT } from 'jose'
import { authorization, callbackGrant, issuer, validateTokens, syntheticRequest, readProbeStream } from '../server/chatgpt-protocol.mjs'

function attempt(clientId) { return authorization('urn:uuid:synthetic-host', 'http://127.0.0.1:54321/auth/callback', clientId) }
function callback(pending, extra = {}) { return new URLSearchParams({ state: pending.state, code: 'synthetic-code', client_id: 'oaiapp_synthetic', ...extra }) }
function stream(events, { terminal = true, chunked = false } = {}) {
  const text = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + (terminal ? 'data: {"type":"response.completed"}\r\n\r\n' : '')
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) {
    if (chunked) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
    else controller.enqueue(bytes)
    controller.close()
  } }))
}

describe('isolated ChatGPT authorization', () => {
  it('uses fresh state, nonce and PKCE with the documented dynamic client and stable host', () => {
    const first = attempt()
    const second = attempt()
    expect(first.state).not.toBe(second.state)
    expect(first.nonce).not.toBe(second.nonce)
    expect(first.verifier).not.toBe(second.verifier)
    expect(first.url.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(first.url.searchParams.get('agent_name_hint')).toBe('Echo')
    expect(first.url.searchParams.get('ext_agent_host_id')).toBe('urn:uuid:synthetic-host')
    expect(first.url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(first.verifier).digest('base64url'))
    expect(attempt('oaiapp_synthetic').url.searchParams.has('agent_name_hint')).toBe(false)
  })

  it('exchanges with the issued client and exact callback; rejects replay', () => {
    const pending = attempt()
    const params = callback(pending)
    const grant = callbackGrant(params, pending)
    expect(grant.body.get('client_id')).toBe('oaiapp_synthetic')
    expect(grant.body.get('redirect_uri')).toBe(pending.redirectUri)
    expect(grant.body.get('code_verifier')).toBe(pending.verifier)
    expect(() => callbackGrant(params, pending)).toThrow()
  })

  it('rejects forged state, expiry, denial, duplicate fields, and changed returning registration', () => {
    for (const kind of ['state', 'expiry', 'denial', 'duplicate', 'registration', 'missing']) {
      const pending = attempt(kind === 'registration' ? 'oaiapp_original' : undefined)
      const params = callback(pending)
      if (kind === 'state') params.set('state', 'wrong')
      if (kind === 'expiry') pending.expires = 0
      if (kind === 'denial') params.set('error', 'access_denied')
      if (kind === 'duplicate') params.append('code', 'second-code')
      if (kind === 'missing') params.delete('client_id')
      expect(() => callbackGrant(params, pending)).toThrow()
    }
  })

  it('validates signature, issuer, audience, nonce, identity and inference permission', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    async function tokens(overrides = {}, claims = {}) {
      const id_token = await new SignJWT({ nonce: 'synthetic-nonce', ...claims }).setProtectedHeader({ alg: 'RS256' })
        .setIssuer(issuer).setAudience('oaiapp_synthetic').setSubject('synthetic-account').setIssuedAt().setExpirationTime('5m').sign(privateKey)
      return { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', id_token,
        token_type: 'Bearer', expires_in: 300, scope: 'chatgpt.tokens.use.direct', ...overrides }
    }
    await expect(validateTokens(await tokens(), 'oaiapp_synthetic', publicKey, { nonce: 'synthetic-nonce' })).resolves.toMatchObject({ subject: 'synthetic-account' })
    await expect(validateTokens(await tokens(), 'oaiapp_other', publicKey)).rejects.toThrow()
    await expect(validateTokens(await tokens(), 'oaiapp_synthetic', publicKey, { nonce: 'wrong' })).rejects.toThrow()
    await expect(validateTokens(await tokens(), 'oaiapp_synthetic', publicKey, { subject: 'different-account' })).rejects.toThrow()
    await expect(validateTokens(await tokens({ scope: 'openid profile' }), 'oaiapp_synthetic', publicKey)).rejects.toThrow()
    await expect(validateTokens(await tokens({ expires_in: -1 }), 'oaiapp_synthetic', publicKey)).rejects.toThrow()
    const other = await generateKeyPair('RS256')
    await expect(validateTokens(await tokens(), 'oaiapp_synthetic', other.publicKey)).rejects.toThrow()
  })
})

describe('synthetic subscription probe', () => {
  it('uses the preview request contract, fixed data, and zero tools', () => {
    const request = syntheticRequest('synthetic-model')
    expect(request).toMatchObject({ store: false, stream: true, tools: [] })
    for (const field of ['truncation', 'max_output_tokens', 'previous_response_id', 'conversation', 'background']) expect(request).not.toHaveProperty(field)
    const content = JSON.parse(request.input[0].content)
    expect(content.sourceParts).toHaveLength(3)
    expect(content.sourceParts[0].extra).toBe('Preserved source field')
    expect(content.focus).toEqual(['synthetic-middle'])
  })

  it('handles byte-fragmented SSE and waits for terminal completion', async () => {
    const events = [{ type: 'response.output_text.delta', delta: 'amber, cobalt, willow' }]
    await expect(readProbeStream(stream(events, { chunked: true }))).resolves.toBe(true)
    await expect(readProbeStream(stream(events, { terminal: false }))).rejects.toThrow('confirmed completion')
  })

  it('rejects partial success followed by failure, incomplete output, or tool calls', async () => {
    for (const event of [
      { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } },
      { type: 'response.incomplete' },
      { type: 'error' },
      { type: 'response.output_item.added', item: { type: 'function_call' } },
    ]) {
      await expect(readProbeStream(stream([{ type: 'response.output_text.delta', delta: 'amber cobalt willow' }, event]))).rejects.toThrow()
    }
  })

  it('does not claim the marker check passed just because a stream completed', async () => {
    await expect(readProbeStream(stream([{ type: 'response.output_text.delta', delta: 'incomplete synthetic answer' }]))).resolves.toBe(false)
    await expect(readProbeStream(new Response('', { status: 401 }))).rejects.toThrow()
  })
})
