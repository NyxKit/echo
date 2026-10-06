import { createHash, randomBytes } from 'node:crypto'
import { jwtVerify } from 'jose'

export const issuer = 'https://auth.openai.com'
export const resource = 'https://api.openai.com/v1'
export const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

export function authorization(hostId, redirectUri, clientId) {
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const url = new URL(`${issuer}/api/accounts/authorize`)
  const params = {
    client_id: clientId || 'dynamic_agent_client', ext_agent_host_id: hostId,
    response_type: 'code', redirect_uri: redirectUri, scope: scopes, resource,
    state, nonce, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }
  if (!clientId) params.agent_name_hint = 'Echo'
  url.search = new URLSearchParams(params).toString()
  return { url, state, nonce, verifier, redirectUri, clientId, used: false, expires: Date.now() + 300_000 }
}

export function callbackGrant(params, attempt) {
  if (attempt.used || Date.now() > attempt.expires || params.getAll('state').length !== 1 || params.get('state') !== attempt.state) {
    throw new Error('Invalid or expired sign-in callback.')
  }
  attempt.used = true
  if (params.has('error')) throw new Error('Sign-in was declined or failed. Start a new attempt.')
  const suppliedId = params.get('client_id')
  if (params.getAll('client_id').length > 1 || (attempt.clientId && suppliedId && suppliedId !== attempt.clientId)) {
    throw new Error('Sign-in returned a different client registration.')
  }
  const clientId = attempt.clientId || suppliedId
  if (!clientId || !/^oaiapp_[a-zA-Z0-9_-]+$/.test(clientId) || params.getAll('code').length !== 1 || !params.get('code')) {
    throw new Error('Sign-in registration is incomplete.')
  }
  return { clientId, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
    code: params.get('code'), code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource }) }
}

export async function validateTokens(tokens, clientId, keySet, { nonce, subject } = {}) {
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token ||
      tokens.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 ||
      typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || typeof tokens.id_token !== 'string') {
    throw new Error('The provider returned an incomplete credential set.')
  }
  const { payload } = await jwtVerify(tokens.id_token, keySet, {
    issuer, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'],
  })
  if ((nonce && payload.nonce !== nonce) || (subject && payload.sub !== subject) ||
      (payload.azp && payload.azp !== clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) {
    throw new Error('The provider identity did not match this sign-in attempt.')
  }
  const granted = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : []
  if (!granted.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan usage was not granted.')
  return { clientId, subject: payload.sub, tokens, expires: Date.now() + tokens.expires_in * 1000 }
}

// This probe accepts no archive, file, free-form prompt, or discussion input.
export function syntheticRequest(model) {
  return {
    model, store: false, stream: true, tools: [],
    instructions: 'Analyze only the supplied synthetic test data. Do not use tools. Reply with the three marker values in chronological order.',
    input: [{ role: 'user', content: JSON.stringify({
      synthetic: true,
      sourceParts: [
        { messages: [{ id: 'synthetic-early', text: 'Marker: amber' }], extra: 'Preserved source field' },
        { messages: [{ id: 'synthetic-middle', text: 'Marker: cobalt' }] },
        { messages: [{ id: 'synthetic-late', text: 'Marker: willow' }] },
      ],
      focus: ['synthetic-middle'], history: [], question: 'Return all three markers, keeping the selected middle message in context.',
    }) }],
  }
}

export async function readProbeStream(response) {
  if (!response.ok || !response.body) throw new Error('The synthetic request was rejected. No archive was sent.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let text = ''
  let completed = false
  let size = 0
  function event(block) {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data || data === '[DONE]') return
    const value = JSON.parse(data)
    if (value.type === 'response.output_text.delta') text += value.delta ?? ''
    if (['error', 'response.failed', 'response.incomplete'].includes(value.type)) throw new Error('The synthetic response failed or was incomplete.')
    if (value.type === 'response.completed') completed = true
    if (value.item?.type && /(?:call|compaction)/.test(value.item.type)) throw new Error('Unexpected tool or context-management event.')
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2_000_000) throw new Error('The synthetic response exceeded the probe limit.')
      pending += decoder.decode(value, { stream: true })
      // Normalize only complete CRLF pairs, including those split across chunks.
      pending = pending.replaceAll('\r\n', '\n')
      let boundary
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        event(pending.slice(0, boundary))
        pending = pending.slice(boundary + 2)
      }
    }
    pending += decoder.decode()
    if (pending.trim()) event(pending)
    if (!completed) throw new Error('The stream ended before confirmed completion.')
    return ['amber', 'cobalt', 'willow'].every(marker => text.toLowerCase().includes(marker))
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
