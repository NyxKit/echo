import { handleDiscussions } from './discussion-http.mjs'
import { handleImports } from '../imports/http.mjs'
import { importErrorCodes } from '../imports/limits.mjs'
import { SESSION_PATH } from './browser-sessions.mjs'
import { bodyless, json, readBody } from './http-input.mjs'

export const LIBRARY_PATH = '/api/library/v1/'
const idPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const paths = {
  versions: new RegExp(`^${LIBRARY_PATH}messages/(${idPattern})/versions$`),
  snapshot: new RegExp(`^${LIBRARY_PATH}conversations/(${idPattern})/snapshot$`),
  messages: new RegExp(`^${LIBRARY_PATH}conversations/(${idPattern})/messages$`),
  position: new RegExp(`^${LIBRARY_PATH}conversations/(${idPattern})/position$`),
  source: new RegExp(`^${LIBRARY_PATH}sources/(${idPattern})$`),
  asset: new RegExp(`^${LIBRARY_PATH}assets/(${idPattern})$`),
}
const errors = {
  session_required: [401, 'Open Echo from its launcher to connect this browser.'],
  invalid_request: [403, 'This request could not be authorized.'],
  request_too_large: [413, 'This request is too large.'],
  library_invalid_input: [400, 'This library request is invalid.'],
  library_not_found: [404, 'This library item is unavailable.'],
  library_asset_unavailable: [404, 'This media is unavailable.'],
  library_owner_required: [409, 'No export owner has been established yet.'],
  library_busy: [503, 'Echo is busy. Try again shortly.'],
  unsupported_media: [415, 'This file cannot be displayed.'],
  unavailable: [503, 'The local library is unavailable. Try again shortly.'],
}

for (const code of importErrorCodes) errors[code] = [code === 'import_busy' ? 409 : code === 'import_disk_full' ? 507 : 400, 'The import could not continue. Review its status and try again.']
errors.library_cleanup_required = [409, 'Library cleanup is incomplete. Retry Delete library to finish.']
errors.library_portability_invalid = [400, 'This discussion file does not match the stored conversation sources or supported format.']
errors.library_context_timestamps_unavailable = [422, 'This conversation has no usable timestamps. Choose All time or attach specific messages.']
errors.library_context_too_large = [413, 'This context exceeds the transfer limit. Choose a narrower scope or a new discussion.']
errors.library_image_limit = [413, 'This discussion exceeds the eight-image limit. Select fewer images or start a new discussion.']
errors.library_context_changed = [409, 'The source or discussion changed. Review context before sending.']
errors.library_draft_conflict = [409, 'This draft changed in another tab. Reload it before saving.']
errors.library_provider_unavailable = [503, 'The provider connection is unavailable.']
errors.library_reconciliation_required = [409, 'Resolve the pending import matches first.']

function query(url, allowed) {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new Error('library_invalid_input')
  return Object.fromEntries(url.searchParams)
}
function integer(value, fallback, min, max) {
  if (value === undefined) return fallback
  if (!/^-?\d+$/.test(value)) throw new Error('library_invalid_input')
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('library_invalid_input')
  return n
}
function mediaType(bytes) {
  const b = Buffer.from(bytes)
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return 'image/gif'
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav'
  if (b.toString('ascii', 0, 3) === 'ID3' || b[0] === 255 && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  if (b.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg'
  if (b.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4'
  if (b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'video/webm'
  throw new Error('unsupported_media')
}
function range(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value ?? '')
  if (!match || (!match[1] && !match[2]) || !size) return undefined
  const first = Number(match[1]), last = Number(match[2])
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return undefined
  if (!match[1]) return last > 0 ? [Math.max(0, size - last), size - 1] : undefined
  const end = match[2] ? Math.min(last, size - 1) : size - 1
  return first < size && first <= end ? [first, end] : undefined
}
function drain(res) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { res.destroy(); done(false) }, 10_000)
    function done(ok) {
      clearTimeout(timer)
      res.off('drain', ready); res.off('close', closed); res.off('error', closed)
      if (ok) resolve(); else reject(new Error('unavailable'))
    }
    const ready = () => done(true), closed = () => done(false)
    res.once('drain', ready); res.once('close', closed); res.once('error', closed)
    if (res.destroyed) closed()
  })
}

export function createLibraryHttp({ library, sessions, origin, onQuit, analysisJobs }) {
  let streams = 0
  async function media(req, res, id) {
    if (streams >= 4) throw new Error('library_busy')
    streams++
    try {
      const { size } = await library.asset({ id })
      const head = await library.readAsset({ id, offset: 0, length: 32 })
      const type = mediaType(head.bytes)
      const requested = req.method === 'GET' && req.headers.range && !req.headers['if-range']
      const slice = requested ? range(req.headers.range, size) : [0, size - 1]
      if (!slice) { res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }).end(); return }
      const [start, end] = slice
      const headers = { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline' }
      if (requested) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      res.writeHead(requested ? 206 : 200, headers)
      if (req.method === 'HEAD') { res.end(); return }
      for (let offset = start; offset <= end && !res.destroyed;) {
        const { bytes } = await library.readAsset({ id, offset, length: Math.min(1024 * 1024, end - offset + 1) })
        if (!bytes.length) throw new Error('library_asset_unavailable')
        offset += bytes.length
        if (!res.write(bytes)) await drain(res)
      }
      res.end()
    } finally { streams-- }
  }
  return async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox")
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    try {
      if (req.url === SESSION_PATH && req.method === 'POST') { await sessions.redeem(req, res); return }
      const url = new URL(req.url, origin)
      const assetId = paths.asset.exec(url.pathname)?.[1]
      sessions.authorize(req, { media: !!assetId })
      if (!['POST', 'PUT'].includes(req.method)) bodyless(req)
      if (req.method === 'POST' && url.pathname === LIBRARY_PATH + 'delete') {
        query(url, []); bodyless(req)
        await analysisJobs?.pause()
        try { json(res, 200, { version: 1, ...await library.deleteLibrary() }) }
        finally { analysisJobs?.resume() }
        return
      }
      if (library.imports && await handleImports(req, res, url, library.imports)) return
      if (analysisJobs && await handleDiscussions(req, res, url, library, analysisJobs)) return
      if (req.method === 'GET' && url.pathname === `${LIBRARY_PATH}status`) {
        query(url, [])
        json(res, 200, await library.status()); return
      }
      if (req.method === 'POST' && [SESSION_PATH + '/disconnect', LIBRARY_PATH + 'quit'].includes(url.pathname)) {
        query(url, []); bodyless(req)
        if (url.pathname.endsWith('/disconnect')) { sessions.disconnect(req, res); json(res, 200, { version: 1, status: 'disconnected' }) }
        else { res.once('finish', onQuit); json(res, 200, { version: 1, status: 'stopping' }) }
        return
      }
      if (assetId && ['GET', 'HEAD'].includes(req.method)) { query(url, []); await media(req, res, assetId); return }
      if (req.method === 'GET' && url.pathname === `${LIBRARY_PATH}conversations`) {
        const fields = query(url, ['after', 'limit'])
        json(res, 200, { version: 1, items: await library.conversations({ after: fields.after, limit: integer(fields.limit, 100, 1, 500) }) }); return
      }
      if (req.method === 'GET' && url.pathname === `${LIBRARY_PATH}preferences`) {
        query(url, []); json(res, 200, { version: 1, ...await library.preferences() }); return
      }
      if (req.method === 'POST' && [LIBRARY_PATH + 'preferences', LIBRARY_PATH + 'identity'].includes(url.pathname)) {
        query(url, [])
        if (req.headers['content-type'] !== 'application/json') throw new Error('library_invalid_input')
        let value
        try { value = JSON.parse(await readBody(req, 8192)) } catch { throw new Error('library_invalid_input') }
        const identity = url.pathname.endsWith('/identity'), keys = identity ? ['label'] : ['key','value']
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('library_invalid_input')
        json(res, 200, { version: 1, ...await (identity ? library.correctIdentity(value) : library.savePreference(value)) }); return
      }
      const versionId = paths.versions.exec(url.pathname)?.[1]
      if (versionId && req.method === 'GET') {
        const fields = query(url, ['after','limit'])
        json(res, 200, { version: 1, items: await library.messageVersions({ messageId: versionId, after: integer(fields.after, 0, 0, Number.MAX_SAFE_INTEGER), limit: integer(fields.limit, 20, 1, 100) }) }); return
      }
      const snapshotId = paths.snapshot.exec(url.pathname)?.[1]
      if (snapshotId && req.method === 'GET') { query(url, []); json(res, 200, { version: 1, ...await library.snapshot({ conversationId: snapshotId }) }); return }
      const conversationId = paths.messages.exec(url.pathname)?.[1]
      if (conversationId && req.method === 'GET') {
        const fields = query(url, ['after', 'limit'])
        json(res, 200, { version: 1, items: await library.messages({ conversationId, after: integer(fields.after, -1, -1, Number.MAX_SAFE_INTEGER), limit: integer(fields.limit, 100, 1, 500) }) }); return
      }
      const partId = paths.source.exec(url.pathname)?.[1]
      if (partId && req.method === 'GET') {
        query(url, [])
        json(res, 200, { version: 1, ...await library.source({ partId }) }); return
      }
      const positionId = paths.position.exec(url.pathname)?.[1]
      if (positionId && req.method === 'GET') {
        query(url, [])
        json(res, 200, { version: 1, position: await library.position({ conversationId: positionId }) }); return
      }
      if (positionId && req.method === 'POST') {
        query(url, [])
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new Error('library_invalid_input')
        let value
        try { value = JSON.parse(await readBody(req, 2048)) } catch (error) { throw new Error(error.message === 'request_too_large' ? error.message : 'library_invalid_input') }
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['messageId', 'offset'].includes(key))) throw new Error('library_invalid_input')
        json(res, 200, { version: 1, position: await library.savePosition({ conversationId: positionId, messageId: value.messageId, offset: value.offset }) }); return
      }
      json(res, 404, { version: 1, code: 'not_found', error: 'This library action is unavailable.' })
    } catch (error) {
      if (res.headersSent) { res.destroy(); return }
      const code = Object.hasOwn(errors, error?.message) ? error.message : 'unavailable'
      const [status, message] = errors[code]
      res.setHeader('Connection', 'close')
      json(res, status, { version: 1, code, error: message })
    }
  }
}
