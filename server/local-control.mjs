import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { request } from 'node:http'

export const CONTROL_PATH = '/api/local/v1/'
const lifetime = 30_000
const mac = (secret, values) => createHmac('sha256', secret).update(JSON.stringify(values)).digest('hex')
const equal = (a, b) => typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const requestMac = (state, method, path, timestamp, nonce) => mac(state.secret, ['echo-control-v1', state.instanceId, method, path, timestamp, nonce])
const responseMac = (state, nonce, status, body) => mac(state.secret, ['echo-reply-v1', state.instanceId, nonce, status, body])

export function controlHeaders(state, method, path, { timestamp = String(Date.now()), nonce = randomBytes(24).toString('hex') } = {}) {
  return { 'X-Echo-Time': timestamp, 'X-Echo-Nonce': nonce, 'X-Echo-Proof': requestMac(state, method, path, timestamp, nonce) }
}

export function createControlAuthority(state, now = Date.now) {
  const used = new Map()
  return {
    accept(req) {
      const timestamp = req.headers['x-echo-time']
      const nonce = req.headers['x-echo-nonce']
      const time = now()
      for (const [key, expiry] of used) if (expiry < time) used.delete(key)
      if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined ||
          req.headers['content-length'] && req.headers['content-length'] !== '0' || req.headers['transfer-encoding'] ||
          typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) || Math.abs(time - Number(timestamp)) > lifetime ||
          typeof nonce !== 'string' || !/^[a-f0-9]{48}$/.test(nonce) || used.has(nonce) || used.size >= 1024 ||
          !equal(req.headers['x-echo-proof'], requestMac(state, req.method, req.url, timestamp, nonce))) return false
      used.set(nonce, Number(timestamp) + lifetime)
      return true
    },
    reply(req, res, status, value) {
      const body = JSON.stringify(value)
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
        'X-Echo-Proof': responseMac(state, req.headers['x-echo-nonce'], status, body) })
      res.end(body)
    },
  }
}

// Authenticate both directions: a port occupied by another service cannot prove readiness.
export function callControl(state, action = 'status', { timeout = 1500 } = {}) {
  const method = ['quit', 'launch'].includes(action) ? 'POST' : 'GET'
  const path = `${CONTROL_PATH}${action}`
  const headers = controlHeaders(state, method, path)
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('instance_unavailable'))
    const req = request({ hostname: '127.0.0.1', port: state.port, method, path, headers, agent: false }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy() })
      res.on('error', fail)
      res.on('end', () => {
        clearTimeout(deadline)
        if (!equal(res.headers['x-echo-proof'], responseMac(state, headers['X-Echo-Nonce'], res.statusCode, body))) { fail(); return }
        try {
          const result = JSON.parse(body)
          if (res.statusCode !== 200 || result.version !== 1 || result.instanceId !== state.instanceId ||
              !['ready', 'stopping'].includes(result.status)) { fail(); return }
          if (action === 'launch' && !/^[a-f0-9-]{36}$/.test(result.launchId ?? '')) { fail(); return }
          resolve(result)
        } catch { fail() }
      })
    })
    const deadline = setTimeout(() => req.destroy(), timeout)
    req.on('error', fail)
    req.on('close', () => clearTimeout(deadline))
    req.end()
  })
}
