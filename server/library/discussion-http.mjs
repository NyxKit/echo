import { json, readBody, bodyless } from './http-input.mjs'
const base = '/api/library/v1/'
const uuid = '[a-f0-9-]{36}'
const conversations = new RegExp(`^${base}conversations/(${uuid})/discussions$`)
const discussions = new RegExp(`^${base}discussions/(${uuid})(?:/(turns|delete|prepare))?$`)
const turns = new RegExp(`^${base}turns/(${uuid})(?:/(cancel))?$`)
async function input(req, keys, limit = 32_768) {
  if (req.headers['content-type'] !== 'application/json') throw new Error('library_invalid_input')
  let value
  try { value = JSON.parse(await readBody(req, limit)) } catch { throw new Error('library_invalid_input') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('library_invalid_input')
  return value
}
export async function handleDiscussions(req, res, url, library, jobs) {
  const conversation = conversations.exec(url.pathname), discussion = discussions.exec(url.pathname), turn = turns.exec(url.pathname)
  if (!conversation && !discussion && !turn) return false
  if (url.search) throw new Error('library_invalid_input')
  if (conversation && !conversation[2] && req.method === 'GET') { json(res, 200, { version: 1, items: await library.discussions({ conversationId: conversation[1] }) }); return true }
  if (discussion) {
    const [, id, action] = discussion
    if (!action && req.method === 'GET') { json(res, 200, { version: 1, ...await library.discussion({ discussionId: id }) }); return true }
    if (!action && req.method === 'PUT') {
      const value = await input(req, ['conversationId','title','draft','scope','draftRevision'])
      json(res, 200, { version: 1, ...await library.saveDiscussion({ ...value, id }) }); return true
    }
    if (action === 'prepare' && req.method === 'POST') {
      const value = await input(req, ['question','focus','scope','model'])
      json(res, 200, await jobs.prepare(req, { ...value, discussionId: id })); return true
    }
    if (action === 'turns' && req.method === 'POST') {
      const { payload } = await input(req, ['payload'], 24_100_000)
      json(res, 202, await jobs.accept(req, { discussionId: id, payload })); return true
    }
    if (action === 'delete' && req.method === 'POST') {
      bodyless(req); json(res, 200, { version: 1, ...await jobs.deleteDiscussion(id) }); return true
    }
  }
  if (turn) {
    if (!turn[2] && req.method === 'GET') { json(res, 200, { version: 1, turn: await library.analysisTurn({ turnId: turn[1] }) }); return true }
    if (turn[2] === 'cancel' && req.method === 'POST') { bodyless(req); json(res, 200, await jobs.cancel(turn[1])); return true }
  }
  throw new Error('library_invalid_input')
}
