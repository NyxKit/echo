import { bodyless, json, readBody, readBytes } from '../library/http-input.mjs'
import { importLimits } from './limits.mjs'
const prefix = '/api/library/v1/imports'
const pattern = /^\/api\/library\/v1\/imports\/([a-f0-9-]{36})(?:\/(files)(?:\/([a-f0-9-]{36})(?:\/(complete))?)?|\/(accept|review|cancel|cleanup))?$/
async function input(req, keys) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new Error('import_invalid')
  let value
  try { value = JSON.parse(await readBody(req, 1024 * 1024)) } catch { throw new Error('import_invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('import_invalid')
  return value
}
export async function handleImports(req, res, url, service) {
  if (!url.pathname.startsWith(prefix)) return false
  if (url.pathname === prefix && !url.search) {
    if (req.method === 'GET') { json(res, 200, { version: 1, jobs: service.list() }); return true }
    if (req.method === 'POST') { json(res, 201, await service.create(await input(req, ['kind']))); return true }
  }
  const match = pattern.exec(url.pathname)
  if (!match) throw new Error('import_invalid')
  const [, id, files, fileId, complete, action] = match
  if (req.method === 'PUT' && fileId && !complete) {
    if (url.searchParams.size !== 1 || !/^\d+$/.test(url.searchParams.get('offset') ?? '') || req.headers['content-type'] !== 'application/octet-stream') throw new Error('import_invalid')
    const offset = Number(url.searchParams.get('offset'))
    if (!Number.isSafeInteger(offset)) throw new Error('import_invalid')
    json(res, 200, await service.chunk(id, fileId, offset, await readBytes(req, importLimits.chunk))); return true
  }
  if (url.search) throw new Error('import_invalid')
  if (!files && !action && req.method === 'GET') { json(res, 200, service.status(id)); return true }
  if (req.method !== 'POST') throw new Error('import_invalid')
  if (files && !fileId) { json(res, 201, await service.beginFile(id, await input(req, ['path', 'size']))); return true }
  if (action === 'review') {
    const value = await input(req, ['ownerChoice', 'conversations', 'messages'])
    json(res, 202, await service.review(id, value)); return true
  }
  bodyless(req)
  if (complete) json(res, 200, await service.finishFile(id, fileId))
  else if (action === 'accept') json(res, 202, await service.accept(id))
  else if (action === 'cancel') json(res, 200, await service.cancel(id))
  else if (action === 'cleanup') json(res, 200, await service.retryCleanup(id))
  else throw new Error('import_invalid')
  return true
}
