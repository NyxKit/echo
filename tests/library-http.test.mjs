import { afterEach, describe, expect, it, vi } from 'vitest'
import { request } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { startApplication } from '../server/application.mjs'
import { newInstance } from '../server/runtime-state.mjs'
import { callControl } from '../server/local-control.mjs'
import { openLibrary } from '../server/library/client.mjs'

const cleanup = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const prefix = '/api/library/v1/'
const source = '{"title":"Synthetic thread","messages":[{"sender_name":"Synthetic Self","content":"Synthetic text","timestamp_ms":1}],"extra":9007199254740993123}'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')

function http(origin, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(origin, { method, path, headers, agent: false }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString() }) })
    })
    req.on('error', reject); req.end(body)
  })
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'echo-synthetic-http-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'ui'), runtime = join(directory, 'runtime')
  await mkdir(root); await mkdir(runtime, { mode: 0o700 })
  await writeFile(join(root, 'index.html'), '<!doctype html><html><head><title>Synthetic</title></head><body>Synthetic UI</body></html>')
  const library = await openLibrary(join(directory, 'library'))
  cleanup.push(() => library.close())
  const identity = await library.resolveOwner({ label: 'Synthetic Self', evidenceJson: '{"reviewed":"synthetic"}' })
  const conversation = await library.importConversation({ evidenceId: identity.evidenceId, title: 'Synthetic thread', participants: ['Synthetic Self'], sourceParts: [source] })
  async function asset(bytes) {
    const upload = await library.beginAsset()
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) await library.appendAsset({ id: upload.id, bytes: bytes.subarray(offset, offset + 1024 * 1024) })
    return library.finishAsset({ id: upload.id })
  }
  const image = await asset(png)
  let now = Date.now()
  const state = newInstance(0), quit = vi.fn()
  const service = { close: vi.fn(async () => {}), handle: vi.fn((_req, res) => res.writeHead(200).end()) }
  const app = await startApplication({ root, state, library, browserDirectory: runtime, browserNow: () => now, createService: () => service, onQuit: quit })
  cleanup.push(() => app.close())
  async function launch() {
    const { launchId } = await callControl(state, 'launch')
    const path = join(runtime, `launch-${launchId}.html`)
    const html = await readFile(path, 'utf8')
    const code = /name="code" value="([A-Za-z0-9_-]+)"/.exec(html)[1]
    return { path, html, code, launchId }
  }
  const redeem = (code, headers = {}) => http(app.origin, prefix + 'session', { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ code }).toString() })
  async function pair() {
    const ticket = await launch()
    const response = await redeem(ticket.code)
    expect(response.status).toBe(303)
    return response.headers['set-cookie'][0].split(';')[0]
  }
  const call = (path, cookie, options = {}) => http(app.origin, prefix + path, { ...options, headers: { Origin: app.origin, 'X-Echo-Request': '1', Cookie: cookie ?? '', ...options.headers } })
  return { ...app, directory, runtime, state, library, service, conversation, image, launch, redeem, pair, call, quit, asset,
    advance(ms) { now += ms } }
}

describe('OS-paired browser library API', () => {
  it('pairs and scopes note reads and writes, rejects conflicts, and never calls the provider', async () => {
    const app = await fixture(), cookie = await app.pair(), path = `conversations/${app.conversation.id}/context`
    const options = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: '**Synthetic** background', revision: 0 }) }
    expect((await app.call(path, undefined, options)).status).toBe(401)
    expect((await app.call(path, cookie, { ...options, headers: { ...options.headers, Origin: 'https://foreign.invalid' } })).status).toBe(403)
    expect((await app.call(path + '?owner=synthetic', cookie)).status).toBe(400)
    expect((await app.call(path, cookie, { ...options, body: JSON.stringify({ markdown: 'Synthetic', revision: 0, userId: randomUUID() }) })).status).toBe(400)
    expect(JSON.parse((await app.call(path, cookie)).text)).toMatchObject({ markdown: '', revision: 0 })
    const result = await app.call(path, cookie, options)
    expect(result.status).toBe(200); expect(result.headers['cache-control']).toContain('no-store')
    expect(JSON.parse(result.text)).toMatchObject({ markdown: '**Synthetic** background', revision: 1 })
    const conflict = await app.call(path, cookie, options)
    expect(conflict.status).toBe(409); expect(conflict.text).not.toContain('**Synthetic**')
    expect((await app.call(`conversations/${randomUUID()}/context`, cookie)).status).toBe(404)
    expect(app.service.handle).not.toHaveBeenCalled()
  })
  it('checks context freshness locally behind pairing and origin checks without calling the provider',async()=>{
    const app=await fixture(),cookie=await app.pair(),id=randomUUID()
    await app.library.saveDiscussion({ id,conversationId: app.conversation.id,title: 'Synthetic context',draft: '',scope: 'week' })
    const path=`discussions/${id}/context-status`,options={ method: 'POST',headers: { 'Content-Type': 'application/json' },body: JSON.stringify({ scope: 'week',focus: [] }) }
    expect((await app.call(path,undefined,options)).status).toBe(401)
    expect((await app.call(path,cookie,{ ...options,headers: { ...options.headers,Origin: 'https://foreign.invalid' } })).status).toBe(403)
    expect((await app.call(path,cookie,{ ...options,body: JSON.stringify({ scope: 'week',focus: [],question: 'Not accepted by this endpoint' }) })).status).toBe(400)
    const result=await app.call(path,cookie,options)
    expect(result.status).toBe(200)
    expect(JSON.parse(result.text)).toMatchObject({ version: 1,status: 'initial',scope: 'week' })
    expect(result.headers['cache-control']).toContain('no-store')
    expect(app.service.handle).not.toHaveBeenCalled()
    expect((await app.library.discussion({ discussionId: id })).turns).toEqual([])
  })
  it('authorizes clearing unused discussions and refuses stale revisions without deleting newer drafts', async () => {
    const app = await fixture(), cookie = await app.pair(), id = randomUUID()
    const saved = await app.library.saveDiscussion({ id, conversationId: app.conversation.id, title: 'New discussion', draft: 'Unsent synthetic draft', scope: 'week' })
    const path = `discussions/${id}/discard-empty`
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draftRevision: saved.draftRevision }) }
    expect((await app.call(path, undefined, options)).status).toBe(401)
    expect((await app.call(path, cookie, { ...options, headers: { ...options.headers, Origin: 'https://foreign.invalid' } })).status).toBe(403)
    expect((await app.call(path, cookie, { ...options, body: '{"draftRevision":0}' })).status).toBe(400)
    const changed = await app.library.saveDiscussion({ ...saved, draft: 'Newer synthetic draft' })
    expect(JSON.parse((await app.call(path, cookie, options)).text)).toEqual({ version: 1, deleted: false })
    expect((await app.library.discussion({ discussionId: id })).draft).toBe('Newer synthetic draft')
    expect(JSON.parse((await app.call(path, cookie, { ...options, body: JSON.stringify({ draftRevision: changed.draftRevision }) })).text)).toEqual({ version: 1, deleted: true })
  })
  it('authorizes explicit prompt-only subject generation and exposes no prompt or title in maintenance responses', async () => {
    const app = await fixture(), cookie = await app.pair(), id = randomUUID()
    await app.library.saveDiscussion({ id, conversationId: app.conversation.id, title: 'New discussion', draft: '', scope: 'full' })
    const snapshot = await app.library.snapshot({ conversationId: app.conversation.id })
    const payload = { requestId: randomUUID(), model: 'gpt-6.1-sol', sourceVersion: snapshot.sourceVersion,
      contextVersion: createHash('sha256').update(JSON.stringify(snapshot.sourceParts)).digest('hex'), sourceParts: snapshot.sourceParts, history: [],
      turn: { question: 'Synthetic first prompt', focus: [], context: { scope: 'full' }, images: [], excluded: [] } }
    const accepted = await app.library.acceptTurn({ discussionId: id, payload, providerAccount: 'a'.repeat(64) })
    await app.library.updateTurn({ turnId: accepted.id, answer: 'Synthetic answer', status: 'complete' })
    app.service.generateSubject = vi.fn(async () => 'Generated synthetic subject')
    const path = `discussions/${id}/subject`, options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":"gpt-6.1-sol"}' }
    expect((await app.call('debug/discussion-subjects')).status).toBe(401)
    expect((await app.call(path, undefined, options)).status).toBe(401)
    expect((await app.call(path, cookie, { ...options, headers: { ...options.headers, Origin: 'https://foreign.invalid' } })).status).toBe(403)
    expect(app.service.generateSubject).not.toHaveBeenCalled()
    expect(JSON.parse((await app.call('debug/discussion-subjects', cookie)).text)).toEqual({ version: 1, items: [id], after: null })
    expect((await app.call('debug/discussion-subjects?after=invalid', cookie)).status).toBe(400)
    app.service.generateSubject.mockRejectedValueOnce(new Error('expired'))
    expect(JSON.parse((await app.call(path, cookie, options)).text).code).toBe('library_subject_connection_required')
    const generated = await app.call(path, cookie, options)
    expect(generated.status).toBe(200)
    expect(JSON.parse(generated.text)).toEqual({ version: 1, updated: true })
    expect(app.service.generateSubject.mock.calls[1][1]).toEqual({ model: 'gpt-6.1-sol', question: payload.turn.question })
    expect((await app.library.discussion({ discussionId: id })).title).toBe('Generated synthetic subject')
    expect(JSON.parse((await app.call('debug/discussion-subjects', cookie)).text).items).toEqual([])
    expect(JSON.parse((await app.call(path, cookie, options)).text)).toEqual({ version: 1, updated: false })
    expect(app.service.generateSubject).toHaveBeenCalledTimes(2)
  })
  it('does not expose discussion-file import or export', async () => {
    const app = await fixture(), cookie = await app.pair()
    const path = `conversations/${app.conversation.id}/discussions`
    expect((await app.call(`${path}/export`, cookie)).status).toBe(404)
    expect((await app.call(`${path}/import`, cookie, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"synthetic"}' })).status).toBe(404)
  })
  it('publishes no bootstrap credentials and requires signed OS launch before pairing', async () => {
    const app = await fixture()
    const page = await http(app.origin, '/')
    expect(page.text).toContain('name="echo-runtime" content="local-library"')
    expect(page.text).not.toContain(app.state.secret)
    expect(page.headers['set-cookie']).toBeUndefined()
    const landing = await http(app.origin, '/', { headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } })
    expect(landing.status).toBe(200)
    expect(landing.headers['set-cookie']).toBeUndefined()
    expect((await app.call('status')).status).toBe(401)
    expect((await http(app.origin, '/api/local/v1/launch', { method: 'POST' })).status).toBe(403)
    const ticket = await app.launch()
    expect((await stat(ticket.path)).mode & 0o777).toBe(0o600)
    expect(ticket.html).toContain(`action="${app.origin}${prefix}session"`)
    expect(ticket.html).not.toContain(app.state.secret)
    expect(ticket.html).not.toContain('?code=')
    const paired = await app.redeem(ticket.code)
    expect(paired.status).toBe(303)
    expect(paired.headers.location).toBe('/')
    expect(paired.headers['set-cookie'][0]).toContain('HttpOnly; SameSite=Strict')
    expect(paired.text).not.toContain(ticket.code)
    await expect(readFile(ticket.path)).rejects.toThrow()
    expect((await app.redeem(ticket.code)).status).toBe(401)
    expect(app.service.handle).not.toHaveBeenCalled()
  })

  it('rejects expired, wrong-origin, oversized and malformed pairing attempts', async () => {
    const app = await fixture()
    const ticket = await app.launch()
    expect((await app.redeem(ticket.code, { Origin: 'https://foreign.invalid' })).status).toBe(403)
    expect((await app.redeem(ticket.code, { 'Content-Type': 'application/json' })).status).toBe(403)
    expect((await app.redeem(ticket.code, { Host: 'foreign.invalid' })).status).toBe(403)
    const oversized = await http(app.origin, prefix + 'session', { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'code=' + 'a'.repeat(300) })
    expect(oversized.status).toBe(413)
    app.advance(60_001)
    expect((await app.redeem(ticket.code)).status).toBe(401)
    await app.launch()
    await expect(readFile(ticket.path)).rejects.toThrow()
  })

  it('enforces session, CSRF, origin and query boundaries without accepting caller ownership', async () => {
    const app = await fixture(), cookie = await app.pair()
    for (const headers of [{ Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'same-site' }, { 'X-Echo-Request': '' }, { Host: 'foreign.invalid' }]) {
      expect((await app.call('status', cookie, { headers })).status).toBe(403)
    }
    for (const path of ['conversations?userId=synthetic', 'conversations?limit=1&limit=2', 'conversations?limit=501', 'conversations?limit=NaN', 'conversations?after=invalid']) {
      expect((await app.call(path, cookie)).status).toBe(400)
    }
    expect((await app.call('resolveOwner', cookie, { method: 'POST' })).status).toBe(404)
    expect((await app.call('importConversation', cookie, { method: 'POST' })).status).toBe(404)
    expect((await app.call('quit', cookie, { method: 'POST', headers: { Origin: '' } })).status).toBe(403)
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('returns owner-scoped paginated records and exact source text, and persists authorized reading positions', async () => {
    const app = await fixture(), cookie = await app.pair()
    const listed = await app.call('conversations?limit=1', cookie)
    expect(JSON.parse(listed.text).items[0].id).toBe(app.conversation.id)
    expect(listed.headers['cache-control']).toBe('no-store')
    const messages = JSON.parse((await app.call(`conversations/${app.conversation.id}/messages`, cookie)).text).items
    expect(messages[0].userId).toBe(app.conversation.userId)
    expect(JSON.parse((await app.call(`sources/${messages[0].partId}`, cookie)).text).sourceJson).toBe(source)
    const path = `conversations/${app.conversation.id}/position`
    expect((await app.call(path, cookie, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: messages[0].id, offset: 12, userId: randomUUID() }) })).status).toBe(400)
    const saved = await app.call(path, cookie, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: messages[0].id, offset: 12 }) })
    expect(saved.status).toBe(200)
    expect(JSON.parse((await app.call(path, cookie)).text).position.offset).toBe(12)
    expect((await app.call(`conversations/${randomUUID()}/messages`, cookie)).status).toBe(404)
  })

  it('streams only authorized recognized media with HEAD and single-byte ranges', async () => {
    const app = await fixture(), cookie = await app.pair()
    const path = `assets/${app.image.id}`
    expect((await app.call(path)).status).toBe(401)
    const response = await app.call(path, cookie)
    expect(response.bytes).toEqual(png)
    expect(response.headers['content-type']).toBe('image/png')
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin')
    const native = await http(app.origin, prefix + path, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } })
    expect(native.status).toBe(200)
    expect((await http(app.origin, prefix + path, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403)
    const head = await app.call(path, cookie, { method: 'HEAD' })
    expect(head.status).toBe(200); expect(head.bytes.length).toBe(0)
    expect(Number(head.headers['content-length'])).toBe(png.length)
    const part = await app.call(path, cookie, { headers: { Range: 'bytes=2-6' } })
    expect(part.status).toBe(206); expect(part.bytes).toEqual(png.subarray(2, 7))
    expect(part.headers['content-range']).toBe(`bytes 2-6/${png.length}`)
    expect((await app.call(path, cookie, { headers: { Range: 'bytes=-4' } })).bytes).toEqual(png.subarray(-4))
    for (const value of ['bytes=9999-', 'bytes=5-2', 'bytes=0-2,4-6', 'bytes=-0']) expect((await app.call(path, cookie, { headers: { Range: value } })).status).toBe(416)
    const arbitrary = await app.asset(Buffer.from('<svg onload="alert(1)"></svg>'))
    expect((await app.call(`assets/${arbitrary.id}`, cookie)).status).toBe(415)
  })

  it('revokes disconnected sessions without disconnecting other browsers, expires sessions, and protects Quit', async () => {
    const app = await fixture(), first = await app.pair(), second = await app.pair()
    expect((await app.call('session/disconnect', first, { method: 'POST' })).status).toBe(200)
    expect((await app.call('status', first)).status).toBe(401)
    expect((await app.call('status', second)).status).toBe(200)
    app.advance(12 * 60 * 60 * 1000 + 1)
    expect((await app.call('status', second)).status).toBe(401)
    const renewed = await app.pair()
    const quit = await app.call('quit', renewed, { method: 'POST' })
    expect(JSON.parse(quit.text).status).toBe('stopping')
    expect(app.quit).toHaveBeenCalledOnce()
    expect((await http(app.origin, '/')).status).toBe(503)
  })

  it('allows repeated OS launches while evicting the oldest of sixteen live sessions', async () => {
    const app = await fixture(), first = await app.pair()
    let newest
    for (let i = 0; i < 16; i++) newest = await app.pair()
    expect((await app.call('status', first)).status).toBe(401)
    expect((await app.call('status', newest)).status).toBe(200)
  })

  it('bounds outstanding tickets and removes unused launch files on shutdown', async () => {
    const app = await fixture()
    for (let i = 0; i < 8; i++) await app.launch()
    await expect(app.launch()).rejects.toThrow('instance_unavailable')
    expect((await readdir(app.runtime)).filter(name => name.endsWith('.html'))).toHaveLength(8)
    await app.close()
    expect((await readdir(app.runtime)).filter(name => name.endsWith('.html'))).toEqual([])
  })
})
