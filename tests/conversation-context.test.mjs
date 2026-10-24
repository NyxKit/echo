import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openLibrary } from '../server/library/client.mjs'
import { validateExport } from '../server/imports/validate.mjs'
import { prepareContext } from '../server/library/prepare-context.mjs'
import { createAnalysisJobs } from '../server/library/analysis-jobs.mjs'
import { analysisRequest, validateAnalysis, requestByteLimit } from '../shared/analysis-policy.mjs'
import { editorMarkdown } from '../shared/conversation-context.mjs'

const cleanup = [], account = 'a'.repeat(64)
const self = { name: 'Synthetic Self', user_id: '100', is_self: true }
const peer = (user_id, name = 'Synthetic Peer') => ({ name, user_id })
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'echo-synthetic-notes-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let library = await openLibrary(directory)
  cleanup.push(() => library.close())
  async function thread(key, participants, extra = {}) {
    const jobId = randomUUID(), root = join(directory, 'imports', jobId), id = randomUUID()
    await mkdir(root, { recursive: true, mode: 0o700 })
    const source = JSON.stringify({ owner: { id: '100', name: 'Synthetic Self' }, title: `Synthetic ${key}`, participants,
      messages: [{ sender_name: 'Synthetic Self', content: `Private synthetic messages in ${key}`, timestamp_ms: 1 },
        { sender_name: participants[1]?.name ?? 'Synthetic Peer', content: `Synthetic reply in ${key}`, timestamp_ms: 2 }], ...extra })
    await writeFile(join(root, id), source, { mode: 0o600 })
    await validateExport(root, [{ id, path: `messages/inbox/${key}/message_1.json`, size: Buffer.byteLength(source) }])
    const before = new Set((await library.status()).owner ? (await library.conversations()).map(row => row.id) : [])
    const preview = await library.previewImport({ jobId })
    await library.commitImport({ jobId })
    const target = preview.conversations[0].target
    return target && target !== 'separate' ? target : (await library.conversations()).find(row => !before.has(row.id)).id
  }
  async function save(conversationId, markdown, revision) {
    return library.saveConversationContext({ conversationId, markdown, revision: revision ?? (await library.conversationContext({ conversationId })).revision })
  }
  async function discussion(conversationId, scope = 'week') {
    const discussionId = randomUUID()
    await library.saveDiscussion({ id: discussionId, conversationId, title: 'Synthetic discussion', draft: 'Synthetic question', scope })
    const focus = scope === 'selected' ? [(await library.messages({ conversationId }))[0].id] : []
    return { discussionId, question: 'Synthetic question', model: 'synthetic-model', scope, focus }
  }
  async function complete(input, payload = undefined) {
    payload ??= (await prepareContext(library, input)).payload
    const turn = await library.acceptTurn({ discussionId: input.discussionId, payload, providerAccount: account, input })
    await library.updateTurn({ turnId: turn.id, status: 'complete', answer: 'Synthetic answer' })
    return payload
  }
  return { directory, get library() { return library }, thread, save, discussion, complete,
    async reopen() { await library.close(); library = await openLibrary(directory) } }
}

describe('conversation context persistence and Send snapshots', () => {
  it('stores independent notes, rejects stale writers and survives reimport, self correction and restart', async () => {
    const app = await fixture(), one = await app.thread('one_2001', [self, peer('200')]), two = await app.thread('two_2002', [self, peer('300')])
    expect(await app.library.conversationContext({ conversationId: one })).toMatchObject({ markdown: '', revision: 0 })
    await app.save(one, '**Synthetic** background'); await app.save(two, 'Independent synthetic background')
    await expect(app.save(one, 'Stale overwrite', 0)).rejects.toThrow('library_note_conflict')
    expect(await app.thread('one_2001', [self, peer('200')])).toBe(one)
    await app.library.correctIdentity({ label: 'Synthetic Peer' })
    await app.reopen()
    expect(await app.library.conversationContext({ conversationId: one })).toMatchObject({ markdown: '**Synthetic** background', revision: 1 })
    expect(await app.library.conversationContext({ conversationId: two })).toMatchObject({ markdown: 'Independent synthetic background' })
    await expect(app.library.conversationContext({ conversationId: randomUUID() })).rejects.toThrow('library_not_found')
    await expect(app.save(one, 'x'.repeat(262_145))).rejects.toThrow('library_invalid_input')
  })

  it('inherits only verified direct notes, retaining distinct threads and separating identical display names', async () => {
    const app = await fixture(), a = await app.thread('directa_2001', [self, peer('200')]), alias = await app.thread('alias_2002', [self, peer('200', 'Synthetic Alias')])
    const collision = await app.thread('collision_2003', [self, peer('300')]), unknown = await app.thread('unknown_2004', [self, { name: 'Synthetic Peer', id: '200' }])
    const group = await app.thread('group_2005', [self, peer('200'), peer('200', 'Synthetic Alias'), peer('400')]), otherGroup = await app.thread('othergroup_2006', [self, peer('200'), peer('500')])
    for (const [id, value] of [[a, 'First synthetic background'], [alias, 'Second synthetic background'], [collision, 'Unrelated note'], [unknown, 'Unverified note'], [otherGroup, 'Other group note']]) await app.save(id, value)
    // A previously observed group is not a direct-note source after shrinking.
    await app.thread('othergroup_2006', [self, peer('200')])
    const details = await app.library.conversationContext({ conversationId: group })
    expect(details.inheritance).toBe('resolved'); expect(details.inherited.map(value => value.conversationId).sort()).toEqual([a, alias].sort())
    const input = await app.discussion(group), payload = (await prepareContext(app.library, input)).payload
    expect(payload.turn.background.notes.map(value => value.markdown).sort()).toEqual(['First synthetic background', 'Second synthetic background'])
    expect(new Set(payload.turn.background.notes.map(value => value.participantId))).toEqual(new Set(['instagram:200']))
    expect(payload.sourceParts.join('')).not.toContain('Private synthetic messages in directa')
    expect(JSON.stringify(payload)).not.toContain('Unrelated note'); expect(JSON.stringify(payload)).not.toContain('Other group note')
    const outgoing = analysisRequest(payload)
    expect(outgoing.input.at(-1).content[1].text).toContain('User-provided conversation context')
    expect(JSON.stringify(outgoing)).not.toContain('Private synthetic messages in alias')
    await app.save(group, 'General synthetic background')
    const next = (await prepareContext(app.library, input)).payload
    expect(next.turn.background.notes.filter(note => note.kind === 'group')).toHaveLength(1)
    expect(next.turn.background.notes).toHaveLength(3)
    const direct = (await prepareContext(app.library, await app.discussion(a))).payload
    expect(direct.turn.background.notes.map(note => note.conversationId)).toEqual([a])
  })

  it('keeps unresolved identities visible without guessing or blocking the group note', async () => {
    const app = await fixture(), direct = await app.thread('direct_2001', [self, peer('200')])
    await app.save(direct, 'Do not infer from names')
    const group = await app.thread('group_2002', [self, { name: 'Synthetic Peer' }, { name: 'Synthetic Third' }])
    await app.save(group, 'Usable group background')
    expect(await app.library.conversationContext({ conversationId: group })).toMatchObject({ inheritance: 'unresolved', inherited: [] })
    const payload = (await prepareContext(app.library, await app.discussion(group))).payload
    expect(payload.turn.background.notes.map(note => note.markdown)).toEqual(['Usable group background'])
  })

  it.each(['week', 'selected'])('uses the latest notes for %s follow-ups and retains immutable accepted history', async scope => {
    const app = await fixture(), direct = await app.thread('direct_2001', [self, peer('200')]), group = await app.thread('group_2002', [self, peer('200'), peer('300')])
    await app.save(direct, 'Original individual background'); await app.save(group, 'Original group background')
    const input = await app.discussion(group, scope), first = await app.complete(input)
    await app.save(direct, 'Updated individual background'); await app.save(group, '')
    const follow = { ...input, focus: [] }, second = await app.complete(follow)
    expect(second.turn.background.notes.map(note => note.markdown)).toEqual(['Updated individual background'])
    expect(second.history[0].background).toEqual(first.turn.background)
    expect(second.sourceParts).toEqual(first.sourceParts)
    expect(second.turn.question).toBe(input.question)
    await app.save(direct, '   ')
    const third = await app.complete(follow)
    expect(third.turn.background.notes).toEqual([])
    expect(third.history[0].background).toEqual(first.turn.background)
    await app.reopen()
    expect((await app.library.discussion({ discussionId: input.discussionId })).turns.map(turn => turn.background)).toEqual([first.turn.background, second.turn.background, third.turn.background])
  })

  it('rejects relevant edits, newly available notes and mapping changes before dispatch, while tolerating unrelated edits', async () => {
    const app = await fixture(), direct = await app.thread('direct_2001', [self, peer('200')]), unrelated = await app.thread('unrelated_2002', [self, peer('900')])
    const group = await app.thread('group_2003', [self, peer('200'), peer('300')]), input = await app.discussion(group)
    let requests = 0
    const jobs = createAnalysisJobs({ library: app.library, provider: { prepareJob: async () => ({ providerAccount: account, run: async ({ onEvent }) => { requests++; await onEvent({ type: 'complete' }) } }) } })
    cleanup.push(() => jobs.close())
    const stale = (await jobs.prepare({}, input)).payload
    await app.save(direct, 'New applicable note')
    await expect(jobs.accept({}, { discussionId: input.discussionId, payload: stale })).rejects.toThrow('library_context_changed')
    expect(requests).toBe(0)
    const mapping = (await jobs.prepare({}, input)).payload
    await app.thread('group_2003', [self, peer('400'), peer('300')])
    await expect(jobs.accept({}, { discussionId: input.discussionId, payload: mapping })).rejects.toThrow('library_context_changed')
    expect(requests).toBe(0)
    const fresh = (await jobs.prepare({}, input)).payload
    await app.save(unrelated, 'Unrelated edit')
    expect((await jobs.accept({}, { discussionId: input.discussionId, payload: fresh })).accepted).toBe(true)
    await expect.poll(() => requests).toBe(1)
    expect((await jobs.accept({}, { discussionId: input.discussionId, payload: fresh })).accepted).toBe(false)
    expect(requests).toBe(1)
  })

  it('freezes accepted notes during streaming and keeps them when discussions are deleted', async () => {
    const app = await fixture(), direct = await app.thread('direct_2001', [self, peer('200')])
    await app.save(direct, 'Accepted background')
    const input = await app.discussion(direct), payload = (await prepareContext(app.library, input)).payload
    const turn = await app.library.acceptTurn({ discussionId: input.discussionId, payload, providerAccount: account, input })
    await app.save(direct, 'Later background')
    expect((await app.library.analysisTurn({ turnId: turn.id })).background).toEqual(payload.turn.background)
    await app.library.updateTurn({ turnId: turn.id, status: 'complete', answer: 'Synthetic answer' })
    await app.library.deleteDiscussion({ discussionId: input.discussionId })
    expect(await app.library.conversationContext({ conversationId: direct })).toMatchObject({ markdown: 'Later background' })
    expect((await app.library.deleteLibrary()).deleted).toBe(true)
    const replacement = await app.thread('direct_2001', [self, peer('200')])
    expect(await app.library.conversationContext({ conversationId: replacement })).toMatchObject({ markdown: '', revision: 0 })
  })

  it('migrates old libraries to empty notes and does not backfill historical turns', async () => {
    const app = await fixture(), direct = await app.thread('direct_2001', [self, peer('200')]), input = await app.discussion(direct)
    const legacy = (await prepareContext(app.library, input)).payload
    delete legacy.turn.background
    await app.complete(input, legacy)
    await app.library.close()
    const db = new DatabaseSync(join(app.directory, 'library.sqlite'))
    db.exec('ALTER TABLE discussions DROP COLUMN assets_json; DROP TABLE conversation_context; PRAGMA user_version=6'); db.close()
    await app.reopen()
    await app.save(direct, 'Newly written background')
    const next = (await prepareContext(app.library, { ...input, focus: [] })).payload
    expect(next.history[0].background).toBeUndefined()
    expect(next.turn.background.notes[0].markdown).toBe('Newly written background')
  })

  it('includes note text in transfer limits and keeps active Markdown content literal in the editor', async () => {
    const app = await fixture(), direct = await app.thread('direct_2001', [self, peer('200')])
    await app.save(direct, 'x'.repeat(262_144))
    const payload = (await prepareContext(app.library, await app.discussion(direct))).payload
    const historic = { ...payload.turn, answer: 'Synthetic answer' }
    payload.turn.context = { scope: 'discussion' }
    payload.history = Array.from({ length: 95 }, (_, index) => index ? { ...historic, context: { scope: 'discussion' } } : historic)
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(requestByteLimit)
    expect(() => validateAnalysis(payload)).toThrow('context_too_large')
    expect(editorMarkdown('<img src="https://synthetic.invalid/image"> ![x](https://synthetic.invalid/image)')).toBe('&lt;img src="https://synthetic.invalid/image"> \\![x](https://synthetic.invalid/image)')
    const code = '`<synthetic> ![literal](image)`\n\n```html\n<img src="https://synthetic.invalid/code">\n```\n'
    expect(editorMarkdown(code)).toBe(code)
    expect(editorMarkdown('\\`<img src="https://synthetic.invalid/active">`')).toContain('&lt;img')
    expect(editorMarkdown('```invalid`\n<img src="https://synthetic.invalid/active">')).toContain('&lt;img')
    expect(editorMarkdown('> ```\n<img src="https://synthetic.invalid/active">\n> ```')).toContain('&lt;img')
    expect(editorMarkdown('```\r\n<literal>\r\n```\r\n<img src="https://synthetic.invalid/active">')).toContain('&lt;img')
  })
})
