import { checkPrivate } from '../platform.mjs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensurePrivateDirectory } from '../runtime-state.mjs'
import { readBody } from './http-input.mjs'

export const SESSION_PATH = '/api/library/v1/session'
const hash = value => createHash('sha256').update(value).digest('hex')
const token = () => randomBytes(32).toString('base64url')
const ticketLife = 60_000
const sessionLife = 12 * 60 * 60 * 1000
const launchName = id => `launch-${id}.html`

export async function createBrowserSessions({ origin, directory, now = Date.now }) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('invalid_request')
  await ensurePrivateDirectory(directory)
  const cookieName = `echo_library_${new URL(origin).port}`
  const tickets = new Map(), sessions = new Map()
  let closed = false
  let cleanupError = false
  async function remove(id) {
    const path = join(directory, launchName(id))
    try {
      const file = await lstat(path)
      checkPrivate(path, file)
      if (!file.isFile()) throw new Error('session_storage_failed')
      await unlink(path)
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('session_storage_failed') }
  }
  for (const name of await readdir(directory)) {
    const match = /^launch-([a-f0-9-]{36})\.html$/.exec(name)
    if (match) await remove(match[1])
  }
  async function prune() {
    for (const [id, entry] of tickets) if (entry.used || entry.expires <= now()) { await remove(id); tickets.delete(id) }
    for (const [key, expires] of sessions) if (expires <= now()) sessions.delete(key)
    cleanupError = false
  }
  const timer = setInterval(() => { void prune().catch(() => { cleanupError = true }) }, 15_000)
  timer.unref()
  function cookie(req) {
    const values = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`))
    return values.length === 1 ? values[0].slice(cookieName.length + 1) : ''
  }
  function setCookie(res, value, seconds = sessionLife / 1000) {
    res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}`)
  }
  return {
    async launch() {
      if (closed) throw new Error('session_unavailable')
      await prune()
      if (tickets.size >= 8) throw new Error('session_limit')
      const id = randomUUID(), code = token(), nonce = token()
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; form-action ${origin}; base-uri 'none'"><title>Opening Echo</title></head><body><p>Opening Echo…</p><form method="post" action="${origin}${SESSION_PATH}"><input type="hidden" name="code" value="${code}"><button type="submit">Open Echo</button></form><script nonce="${nonce}">document.forms[0].requestSubmit()</script></body></html>`
      tickets.set(id, { codeHash: hash(code), expires: now() + ticketLife, used: false, ready: false })
      try {
        await writeFile(join(directory, launchName(id)), html, { flag: 'wx', mode: 0o600 })
        if (closed) { await remove(id); tickets.delete(id); throw new Error('session_unavailable') }
        tickets.get(id).ready = true
      } catch (error) {
        const entry = tickets.get(id)
        if (entry) entry.used = true
        try { await remove(id); tickets.delete(id) } catch { cleanupError = true }
        throw error
      }
      return id
    },
    async redeem(req, res) {
      if (closed || cleanupError || req.url !== SESSION_PATH || req.method !== 'POST' ||
          !['null', origin].includes(req.headers.origin) ||
          (req.headers['sec-fetch-mode'] && req.headers['sec-fetch-mode'] !== 'navigate') ||
          (req.headers['sec-fetch-dest'] && req.headers['sec-fetch-dest'] !== 'document') ||
          !/^application\/x-www-form-urlencoded(?:;\s*charset=UTF-8)?$/i.test(req.headers['content-type'] ?? '')) throw new Error('invalid_request')
      const fields = new URLSearchParams(await readBody(req, 256))
      if (fields.size !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(fields.get('code') ?? '')) throw new Error('invalid_request')
      const digest = hash(fields.get('code'))
      for (const [key, expires] of sessions) if (expires <= now()) sessions.delete(key)
      const found = [...tickets].find(([, entry]) => entry.codeHash === digest && entry.ready && !entry.used && entry.expires > now())
      if (!found) throw new Error('session_required')
      const [id, entry] = found
      entry.used = true
      await remove(id); tickets.delete(id)
      if (closed) throw new Error('session_required')
      const previous = cookie(req)
      if (previous) sessions.delete(hash(previous))
      // A cross-site file form may omit the old Strict cookie. Bound retained
      // sessions without preventing a deliberate OS-authorized new launch.
      while (sessions.size >= 16) sessions.delete(sessions.keys().next().value)
      const session = token()
      sessions.set(hash(session), now() + sessionLife)
      setCookie(res, session)
      res.writeHead(303, { Location: '/' }).end()
    },
    authorize(req, { media = false } = {}) {
      if (closed || (req.headers.origin && req.headers.origin !== origin) ||
          (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) ||
          (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== origin) ||
          (req.headers['x-echo-request'] !== '1' && !(media && req.headers['sec-fetch-site'] === 'same-origin'))) throw new Error('invalid_request')
      const value = cookie(req)
      if (!/^[A-Za-z0-9_-]{43}$/.test(value) || (sessions.get(hash(value)) ?? 0) <= now()) throw new Error('session_required')
    },
    disconnect(req, res) {
      sessions.delete(hash(cookie(req)))
      setCookie(res, '', 0)
    },
    async close() {
      closed = true
      clearInterval(timer)
      sessions.clear()
      for (const id of tickets.keys()) { await remove(id); tickets.delete(id) }
    },
  }
}
