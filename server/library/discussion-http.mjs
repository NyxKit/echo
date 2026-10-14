import { json, readBody, bodyless } from './http-input.mjs'
const base = '/api/library/v1/'
const uuid = '[a-f0-9-]{36}'
const conversations = new RegExp(`^${base}conversations/(${uuid})/discussions$`)
const discussions = new RegExp(`^${base}discussions/(${uuid})(?:/(turns|delete|prepare|context-status|subject|discard-empty))?$`)
const turns = new RegExp(`^${base}turns/(${uuid})(?:/(cancel))?$`)
async function input(req, keys, limit = 32_768) {
  if (req.headers['content-type'] !== 'application/json') throw new Error('library_invalid_input')
  let value
  try { value = JSON.parse(await readBody(req, limit)) } catch { throw new Error('library_invalid_input') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('library_invalid_input')
  return value
}
export async function handleDiscussions(req, res, url, library, jobs) {
  if (url.pathname === base + 'debug/discussion-subjects' && req.method === 'GET') {
    if ([...url.searchParams.keys()].some(key => key !== 'after') || url.searchParams.getAll('after').length > 1) throw new Error('library_invalid_input')
    json(res, 200, { version: 1, ...await library.discussionSubjectCandidates({ after: url.searchParams.get('after') ?? '' }) }); return true
  }
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
    if (action === 'discard-empty' && req.method === 'POST') {
      const { draftRevision } = await input(req, ['draftRevision'])
      json(res, 200, { version: 1, ...await library.discardEmptyDiscussion({ discussionId: id, draftRevision }) }); return true
    }
    if (action === 'subject' && req.method === 'POST') {
      const { model } = await input(req, ['model'])
      const controller = new AbortController()
      const stop = () => { if (!res.writableEnded) controller.abort() }
      res.once('close', stop)
      try { json(res, 200, { version: 1, ...await jobs.generateSubject(req, id, model, controller.signal) }) }
      finally { res.off('close', stop) }
      return true
    }
    if (action === 'prepare' && req.method === 'POST') {
      const value = await input(req, ['question','focus','scope','model'])
      json(res, 200, await jobs.prepare(req, { ...value, discussionId: id })); return true
    }
    if (action === 'context-status' && req.method === 'POST') {
      const value = await input(req, ['focus','scope'])
      json(res, 200, { version: 1, ...await library.contextStatus({ ...value,discussionId: id }) }); return true
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
