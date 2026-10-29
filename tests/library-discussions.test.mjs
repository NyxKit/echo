import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { openLibrary } from '../server/library/client.mjs'
import { createAnalysisJobs } from '../server/library/analysis-jobs.mjs'
import { prepareContext } from '../server/library/prepare-context.mjs'
import { scopedSourceParts } from '../shared/analysis-source.mjs'
const cleanup = [], hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'echo-synthetic-discussions-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let library = await openLibrary(directory)
  cleanup.push(() => library.close())
  const owner = await library.resolveOwner({ label: 'Synthetic Self', evidenceJson: '{"synthetic":true}' })
  const source = '{"title":"Synthetic","unknown":9007199254740993123,"messages":[{"sender_name":"Synthetic Self","content":"Generated","timestamp_ms":1}]}'
  const conversation = await library.importConversation({ evidenceId: owner.evidenceId, title: 'Synthetic', participants: ['Synthetic Self'], sourceParts: [source] })
  const id = randomUUID()
  await library.saveDiscussion({ id, conversationId: conversation.id, title: 'New discussion', draft: 'Generated question', scope: 'surrounding' })
  async function payload() {
    const snapshot = await library.snapshot({ conversationId: conversation.id })
    const turn = { question: 'Generated question', focus: ['p1:m1'], context: { scope: 'selected', references: ['p1:m1'] }, images: [], excluded: [] }
    const sourceParts = scopedSourceParts(snapshot.sourceParts, [turn.context])
    return { requestId: randomUUID(), model: 'synthetic-model', sourceVersion: snapshot.sourceVersion, contextVersion: hash(sourceParts), sourceParts, history: [], turn }
  }
  return { directory, get library() { return library }, owner, conversation, id, source, payload,
    async reopen() { await library.close(); library = await openLibrary(directory) } }
}
const account = 'a'.repeat(64)

describe('durable discussions and immutable analysis snapshots', () => {
  it('orders by latest prompt date after migration and ignores draft saves, renames and unknown legacy dates', async () => {
    const app = await fixture(), ids = []
    for (const sentAt of ['2026-10-27T09:00:00.000Z', '2025-12-31T09:00:00.000Z']) {
      const id = randomUUID(), payload = await app.payload()
      payload.turn.promptTime = { sentAt, timeZone: 'Europe/Brussels' }
      await app.library.saveDiscussion({ id, conversationId: app.conversation.id, title: 'Synthetic discussion', draft: '', scope: 'selected' })
      const accepted = await app.library.acceptTurn({ discussionId: id, payload, providerAccount: account })
      await app.library.updateTurn({ turnId: accepted.id, answer: '', status: 'failed' })
      ids.push(id)
    }
    const legacy = await app.library.acceptTurn({ discussionId: app.id, payload: await app.payload(), providerAccount: account })
    await app.library.updateTurn({ turnId: legacy.id, answer: '', status: 'canceled' })
    const dates = async () => (await app.library.discussions({ conversationId: app.conversation.id })).map(({ id, lastInteractionAt }) => ({ id, lastInteractionAt }))
    expect(await dates()).toEqual([
      { id: ids[0], lastInteractionAt: '2026-10-27T09:00:00.000Z' },
      { id: ids[1], lastInteractionAt: '2025-12-31T09:00:00.000Z' },
      { id: app.id, lastInteractionAt: null },
    ])
    const saved = await app.library.discussion({ discussionId: ids[1] })
    await app.library.saveDiscussion({ ...saved, title: 'Synthetic renamed discussion', draft: 'Synthetic unsent draft' })
    expect((await dates()).map(item => item.id)).toEqual([...ids, app.id])
    const latest = await app.payload()
    latest.turn.promptTime = { sentAt: '2026-10-28T09:00:00.000Z', timeZone: 'Europe/Brussels' }
    await app.library.acceptTurn({ discussionId: ids[1], payload: latest, providerAccount: account })
    const expected = [
      { id: ids[1], lastInteractionAt: latest.turn.promptTime.sentAt },
      { id: ids[0], lastInteractionAt: '2026-10-27T09:00:00.000Z' },
      { id: app.id, lastInteractionAt: null },
    ]
    expect(await dates()).toEqual(expected)
    await app.library.close()
    const db = new DatabaseSync(join(app.directory, 'library.sqlite'))
    try {
      // Recreate the previous schema using only this test's generated library.
      db.exec('ALTER TABLE discussions DROP COLUMN last_interaction_at; PRAGMA user_version=8;')
    } finally { db.close() }
    await app.reopen()
    expect(await dates()).toEqual(expected)
    expect((await app.library.discussion({ discussionId: ids[1] })).lastInteractionAt).toBe(latest.turn.promptTime.sentAt)
  })

  it('cleans up previously saved empty placeholders on startup without deleting drafts, custom names or submitted turns', async () => {
    const app = await fixture(), ids = []
    for (const draft of ['', ' \n\t', '\u00a0']) {
      const id = randomUUID(); ids.push(id)
      await app.library.saveDiscussion({ id, conversationId: app.conversation.id, title: 'New discussion', draft, scope: 'week' })
    }
    const customId = randomUUID()
    await app.library.saveDiscussion({ id: customId, conversationId: app.conversation.id, title: 'My custom title', draft: '', scope: 'week' })
    const keep = [app.id, customId]
    for (const status of ['sending','complete','failed','canceled','interrupted']) {
      const id = randomUUID(), payload = await app.payload()
      await app.library.saveDiscussion({ id, conversationId: app.conversation.id, title: 'New discussion', draft: payload.turn.question, scope: 'week' })
      const accepted = await app.library.acceptTurn({ discussionId: id, payload, providerAccount: account })
      if (status !== 'sending') await app.library.updateTurn({ turnId: accepted.id, answer: '', status })
      const saved = await app.library.discussion({ discussionId: id })
      await app.library.saveDiscussion({ ...saved, title: 'New discussion' })
      keep.push(id)
    }
    const before = await app.library.snapshot({ conversationId: app.conversation.id })
    await app.reopen()
    const saved = await app.library.discussions({ conversationId: app.conversation.id })
    expect(saved.map(item => item.id).sort()).toEqual(keep.sort())
    for (const id of ids) await expect(app.library.discussion({ discussionId: id })).rejects.toThrow('library_not_found')
    expect((await app.library.discussion({ discussionId: app.id })).draft).toBe('Generated question')
    expect(await app.library.snapshot({ conversationId: app.conversation.id })).toEqual(before)
  })
  it('uses revision checks to discard a cleared draft and protects custom titles and accepted prompts', async () => {
    const app = await fixture(), saved = await app.library.discussion({ discussionId: app.id })
    const changed = await app.library.saveDiscussion({ ...saved, draft: 'Changed in another tab' })
    expect(await app.library.discardEmptyDiscussion({ discussionId: app.id, draftRevision: saved.draftRevision })).toEqual({ deleted: false })
    expect((await app.library.discussion({ discussionId: app.id })).draft).toBe('Changed in another tab')
    expect(await app.library.discardEmptyDiscussion({ discussionId: app.id, draftRevision: changed.draftRevision })).toEqual({ deleted: true })
    expect(await app.library.discardEmptyDiscussion({ discussionId: app.id, draftRevision: changed.draftRevision })).toEqual({ deleted: true })
    const id = randomUUID(), payload = await app.payload()
    const named = await app.library.saveDiscussion({ id, conversationId: app.conversation.id, title: 'Custom title', draft: '', scope: 'week' })
    expect(await app.library.discardEmptyDiscussion({ discussionId: id, draftRevision: named.draftRevision })).toEqual({ deleted: false })
    const accepted = await app.library.acceptTurn({ discussionId: id, payload, providerAccount: account })
    await app.library.updateTurn({ turnId: accepted.id, answer: '', status: 'failed' })
    const current = await app.library.discussion({ discussionId: id })
    const fallback = await app.library.saveDiscussion({ ...current, title: 'New discussion' })
    expect(await app.library.discardEmptyDiscussion({ discussionId: id, draftRevision: fallback.draftRevision })).toEqual({ deleted: false })
    expect((await app.library.discussion({ discussionId: id })).turns[0].status).toBe('failed')
  })
  it('saves drafts with optimistic revision checks and preserves stable ownership on restart', async () => {
    const app = await fixture(), original = await app.library.discussion({ discussionId: app.id })
    expect(original.userId).toBe(app.owner.userId)
    await app.library.saveDiscussion({ id: app.id, conversationId: app.conversation.id, title: 'Synthetic title', draft: 'Revised draft', scope: 'full', draftRevision: original.draftRevision })
    await expect(app.library.saveDiscussion({ id: app.id, conversationId: app.conversation.id, title: 'Old tab', draft: 'Stale', scope: 'full', draftRevision: original.draftRevision })).rejects.toThrow('library_draft_conflict')
    await app.reopen()
    expect((await app.library.discussion({ discussionId: app.id })).draft).toBe('Revised draft')
  })
  it('freezes accepted context, deduplicates request IDs and retains partial answers after restart without dispatch', async () => {
    const app = await fixture(), payload = await app.payload()
    const accepted = await app.library.acceptTurn({ discussionId: app.id, payload, providerAccount: account })
    expect(accepted.accepted).toBe(true)
    const discussion = await app.library.discussion({ discussionId: app.id })
    expect(discussion.draft).toBe('')
    expect(discussion.draftRevision).toBe(2)
    expect((await app.library.acceptTurn({ discussionId: app.id, payload, providerAccount: account })).accepted).toBe(false)
    expect((await app.library.discussion({ discussionId: app.id })).draftRevision).toBe(2)
    await app.library.saveDiscussion({ id: app.id, conversationId: app.conversation.id, title: discussion.title,
      draft: 'A new draft', scope: discussion.scope, draftRevision: discussion.draftRevision })
    await app.library.updateTurn({ turnId: accepted.id, answer: 'Generated partial answer' })
    await app.reopen()
    const restored = await app.library.analysisTurn({ turnId: accepted.id })
    expect(restored.status).toBe('interrupted'); expect(restored.error).toBe('outcome_unknown'); expect(restored.answer).toBe('Generated partial answer')
    expect((await app.library.discussion({ discussionId: app.id })).draft).toBe('A new draft')
  })
  it('rejects forged context, provider rebinding, unavailable discussions and stale source preparations', async () => {
    const app = await fixture(), payload = await app.payload()
    const forged = { ...payload, sourceParts: ['{"messages":{"0":{"content":"forged"}}}'] }; forged.contextVersion = hash(forged.sourceParts)
    await expect(app.library.acceptTurn({ discussionId: app.id, payload: forged, providerAccount: account })).rejects.toThrow('library_context_changed')
    expect((await app.library.discussion({ discussionId: app.id })).draft).toBe('Generated question')
    await expect(app.library.acceptTurn({ discussionId: randomUUID(), payload, providerAccount: account })).rejects.toThrow('library_not_found')
    await app.library.resolveOwner({ expectedUserId: app.owner.userId,label: 'Changed synthetic identity',evidenceJson: '{"synthetic":true}' })
    await expect(app.library.acceptTurn({ discussionId: app.id, payload, providerAccount: account })).rejects.toThrow('library_context_changed')
    const fresh = await app.payload()
    await app.library.acceptTurn({ discussionId: app.id, payload: fresh, providerAccount: account })
    await expect(app.library.acceptTurn({ discussionId: app.id, payload: fresh, providerAccount: 'b'.repeat(64) })).rejects.toThrow('library_invalid_input')
  })
  it('backfills only default titles and preserves drafts, history, concurrent edits and stored sources', async () => {
    const app = await fixture(), payload = await app.payload()
    const accepted = await app.library.acceptTurn({ discussionId: app.id, payload, providerAccount: account })
    expect((await app.library.discussionSubjectCandidates()).items).toEqual([])
    await app.library.updateTurn({ turnId: accepted.id, answer: 'Synthetic answer', status: 'complete' })
    expect(await app.library.discussionSubjectCandidates()).toEqual({ items: [app.id], after: null })
    const input = await app.library.discussionSubjectInput({ discussionId: app.id })
    expect(input).toEqual({ id: app.id, title: payload.turn.question, draftRevision: 2, model: payload.model, question: payload.turn.question })
    const saved = await app.library.discussion({ discussionId: app.id })
    await app.library.saveDiscussion({ ...saved, title: 'My custom subject' })
    expect(await app.library.saveDiscussionSubject({ discussionId: app.id, title: 'Generated subject', expectedTitle: input.title, draftRevision: input.draftRevision })).toEqual({ updated: false })
    expect(await app.library.discussionSubjectInput({ discussionId: app.id })).toBeNull()
    expect((await app.library.discussionSubjectCandidates()).items).toEqual([])
    const custom = await app.library.discussion({ discussionId: app.id })
    await app.library.saveDiscussion({ ...custom, title: payload.turn.question, draft: 'Keep my new draft' })
    const ready = await app.library.discussionSubjectInput({ discussionId: app.id })
    expect(await app.library.saveDiscussionSubject({ discussionId: app.id, title: 'Generated subject', expectedTitle: ready.title, draftRevision: ready.draftRevision })).toEqual({ updated: true })
    const final = await app.library.discussion({ discussionId: app.id })
    expect(final).toMatchObject({ title: 'Generated subject', draft: 'Keep my new draft', scope: saved.scope, draftRevision: ready.draftRevision + 1 })
    expect(final.turns).toEqual(saved.turns)
    expect(final.contextSource).toEqual(saved.contextSource)
    expect((await app.library.discussionSubjectCandidates()).items).toEqual([])
    await app.reopen()
    expect((await app.library.discussion({ discussionId: app.id })).title).toBe('Generated subject')
  })
  it('paginates subject candidates even when a scanned page contains no default titles', async () => {
    const app = await fixture(), payload = await app.payload()
    const threads = Array.from({ length: 101 }, (_, index) => ({ title: index === 100 ? payload.turn.question : 'Custom subject', draft: '', scope: 'full', turns: [{ ...payload.turn, context: { scope: 'full' }, answer: 'Synthetic answer', status: 'complete' }] }))
    const ids = []
    for (let index=0; index<threads.length; index+=50) ids.push(...(await app.library.importDiscussions({ conversationId: app.conversation.id, text: JSON.stringify({ version: 4, sourceVersion: hash([app.source]), threads: threads.slice(index,index+50) }) })).ids)
    const candidates = []; let after = ''
    do { const page = await app.library.discussionSubjectCandidates({ after }); candidates.push(...page.items); after = page.after } while (after)
    expect(candidates).toEqual([ids[100]])
    await expect(app.library.discussionSubjectCandidates({ after: 'invalid' })).rejects.toThrow('library_invalid_input')
  })
  it('keeps completed context after imports and supports a discussion-only follow-up against that original context', async () => {
    const app = await fixture(), payload = await app.payload()
    const accepted = await app.library.acceptTurn({ discussionId: app.id, payload, providerAccount: account })
    await app.library.updateTurn({ turnId: accepted.id, answer: 'Synthetic answer', status: 'complete' })
    const saved = await app.library.discussion({ discussionId: app.id })
    await app.library.importConversation({ evidenceId: app.owner.evidenceId, title: 'Another synthetic conversation', participants: ['Synthetic Self'], sourceParts: [app.source] })
    expect((await app.library.discussion({ discussionId: app.id })).contextSource).toEqual(saved.contextSource)
    const prior = saved.turns[0]
    const followup = { ...payload, requestId: randomUUID(), history: [{ question: prior.question, focus: prior.focus, context: prior.context, excluded: prior.excluded, images: prior.images, answer: prior.answer }],
      turn: { question: 'Synthetic follow-up', focus: [], context: { scope: 'discussion' }, excluded: [], images: [] } }
    expect((await app.library.acceptTurn({ discussionId: app.id, payload: followup, providerAccount: account })).accepted).toBe(true)
  })
  it('preserves exact metadata numbers in accumulated full context and deletes discussion state independently', async () => {
    const app = await fixture(), snapshot = await app.library.snapshot({ conversationId: app.conversation.id })
    expect(snapshot.sourceParts[0]).toContain('9007199254740993123')
    expect(snapshot.sourceParts[0]).toContain('echo-library-context-v1')
    await app.library.deleteDiscussion({ discussionId: app.id })
    expect(await app.library.discussions({ conversationId: app.conversation.id })).toEqual([])
    expect(await app.library.messages({ conversationId: app.conversation.id })).toHaveLength(1)
  })
})

describe('server-owned analysis dispatch', () => {
  it('sends only a saved first prompt for subjects and prevents duplicate or canceled updates', async () => {
    const app = await fixture(), payload = await app.payload()
    const accepted = await app.library.acceptTurn({ discussionId: app.id, payload, providerAccount: account })
    await app.library.updateTurn({ turnId: accepted.id, answer: 'Synthetic answer', status: 'complete' })
    let release, sent
    const provider = { generateSubject: async (_req, input) => { sent = input; await new Promise(resolve => { release = resolve }); return 'Generated subject' } }
    const jobs = createAnalysisJobs({ library: app.library, provider }); cleanup.push(() => jobs.close())
    const controller = new AbortController()
    const running = jobs.generateSubject({}, app.id, 'chosen-model', controller.signal)
    for (let i=0; i<100 && !release; i++) await delay(5)
    expect(sent).toEqual({ model: 'chosen-model', question: payload.turn.question })
    await expect(jobs.generateSubject({}, app.id, 'chosen-model', controller.signal)).rejects.toThrow('library_busy')
    controller.abort(); release()
    await expect(running).rejects.toThrow('library_busy')
    expect((await app.library.discussion({ discussionId: app.id })).title).toBe(payload.turn.question)
    provider.generateSubject = async () => 'Generated subject'
    expect(await jobs.generateSubject({}, app.id, 'chosen-model', new AbortController().signal)).toEqual({ updated: true })
    expect(await jobs.generateSubject({}, app.id, 'chosen-model', new AbortController().signal)).toEqual({ updated: false })
  })
  it('continues independently of the accepting request, reconnects to saved output, and does not duplicate sends', async () => {
    const app = await fixture(); let dispatches = 0, release
    const gate = new Promise(resolve => { release = resolve })
    const jobs = createAnalysisJobs({ library: app.library, provider: { prepareJob: async () => ({ providerAccount: account, run: async ({ onEvent }) => {
      dispatches++; await onEvent({ type: 'delta', delta: 'Synthetic ' }); await gate
      await onEvent({ type: 'delta', delta: 'answer' }); await onEvent({ type: 'complete' })
    } }) } })
    cleanup.push(() => jobs.close())
    const focus = [(await app.library.messages({ conversationId: app.conversation.id }))[0].id]
    const { payload } = await jobs.prepare({}, { discussionId: app.id, question: 'Generated question', focus, scope: 'selected', model: 'synthetic-model' }), req = { destroyed: false }
    const accepted = await jobs.accept(req, { discussionId: app.id, payload }); req.destroyed = true
    expect((await jobs.accept({}, { discussionId: app.id, payload })).accepted).toBe(false)
    release()
    let result
    for (let i = 0; i < 100; i++) { result = await app.library.analysisTurn({ turnId: accepted.turn.id }); if (result.status === 'complete') break; await delay(5) }
    expect(result.status).toBe('complete'); expect(result.answer).toBe('Synthetic answer'); expect(dispatches).toBe(1)
  })
  it('cancels accepted work explicitly and persists the outcome', async () => {
    const app = await fixture()
    const jobs = createAnalysisJobs({ library: app.library, provider: { prepareJob: async () => ({ providerAccount: account, run: ({ signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) reject(new Error('cancelled'))
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    }) }) } })
    cleanup.push(() => jobs.close())
    const focus = [(await app.library.messages({ conversationId: app.conversation.id }))[0].id]
    const { payload } = await jobs.prepare({}, { discussionId: app.id, question: 'Generated question', focus, scope: 'selected', model: 'synthetic-model' })
    const accepted = await jobs.accept({}, { discussionId: app.id, payload })
    expect((await jobs.cancel(accepted.turn.id)).turn.status).toBe('canceled')
  })
})

describe('discussion file portability', () => {
  it('round-trips immutable snapshots into new IDs and maps citations in a rebuilt synthetic library', async () => {
    const original = await fixture(), rebuilt = await fixture()
    const promptTime = { sentAt: '2026-10-27T09:00:00.000Z', timeZone: 'Europe/Brussels' }
    const context = await original.library.contextInput({ discussionId: original.id, question: 'Full context', focus: [], scope: 'full', model: 'synthetic-model', promptTime })
    const payload = { requestId: randomUUID(), model: context.model, sourceVersion: context.sourceVersion, sourceParts: context.sourceParts,
      contextVersion: hash(context.sourceParts), history: [], turn: context.turn }
    const accepted = await original.library.acceptTurn({ discussionId: original.id, payload, providerAccount: account })
    await original.library.updateTurn({ turnId: accepted.id, answer: 'Preserved [[p1:m1]]', status: 'complete' })
    const { text } = await original.library.exportDiscussions({ conversationId: original.conversation.id })
    expect(text).not.toContain(account)
    const imported = await rebuilt.library.importDiscussions({ conversationId: rebuilt.conversation.id, text })
    const saved = await rebuilt.library.discussion({ discussionId: imported.ids[0] })
    expect(saved.lastInteractionAt).toBe(promptTime.sentAt)
    expect(saved.turns[0].answer).toBe('Preserved [[p1:m1]]')
    expect(saved.contextSource.sourceParts).toEqual(payload.sourceParts)
    expect(saved.turns[0].referenceMap['p1:m1']).toBe((await rebuilt.library.messages({ conversationId: rebuilt.conversation.id }))[0].id)
    expect((await rebuilt.library.exportDiscussions({ conversationId: rebuilt.conversation.id })).text).toContain('Preserved')
    const followup=await prepareContext(rebuilt.library,{ discussionId: saved.id,question: 'Continue the rebuilt synthetic discussion',scope: 'full',focus: [],model: 'synthetic-model' })
    const continued=await rebuilt.library.acceptTurn({ discussionId: saved.id,payload: followup.payload,providerAccount: account })
    await rebuilt.library.updateTurn({ turnId: continued.id,answer: 'Continued synthetic answer',status: 'complete' })
    const reexported=await rebuilt.library.exportDiscussions({ conversationId: rebuilt.conversation.id })
    expect((await rebuilt.library.importDiscussions({ conversationId: rebuilt.conversation.id,text: reexported.text })).ids).toHaveLength(2)
    expect(saved.id).not.toBe(original.id); expect(saved.turns[0].id).not.toBe(accepted.id)
    const tampered = JSON.parse(text)
    tampered.threads[0].turns[0].payload.sourceParts[0] = payload.sourceParts[0].replace('"unknown":9007199254740993123','"unknown":7')
    tampered.threads[0].turns[0].payload.contextVersion = hash(tampered.threads[0].turns[0].payload.sourceParts)
    await expect(rebuilt.library.importDiscussions({ conversationId: rebuilt.conversation.id, text: JSON.stringify(tampered) })).rejects.toThrow('library_portability_invalid')
  })
  it('migrates original version 1–4 source hashes and preserves them through export and restart', async () => {
    const app = await fixture()
    for (const version of [1,2,3,4]) {
      const file = { version, sourceVersion: hash([app.source]), threads: [{ title: 'Saved synthetic', draft: 'Draft', scope: 'full',
        turns: [{ question: 'Original question', focus: ['p1:m1'], context: { scope: 'full' }, images: [], excluded: [], answer: 'Original answer', status: 'complete' }] }] }
      const imported = await app.library.importDiscussions({ conversationId: app.conversation.id, text: JSON.stringify(file) })
      expect((await app.library.discussion({ discussionId: imported.ids[0] })).turns[0].answer).toBe('Original answer')
    }
    const exported = await app.library.exportDiscussions({ conversationId: app.conversation.id })
    await app.reopen()
    expect((await app.library.importDiscussions({ conversationId: app.conversation.id, text: exported.text })).ids).toHaveLength(5)
    const invalid = { version: 4, sourceVersion: '0'.repeat(64), threads: [{ title: 'Unrelated', draft: '', scope: 'full', turns: [] }] }
    await expect(app.library.importDiscussions({ conversationId: app.conversation.id, text: JSON.stringify(invalid) })).rejects.toThrow('library_portability_invalid')
  })
  it('rejects unrelated conversations and invalid history atomically', async () => {
    const app = await fixture(), payload = await app.payload()
    const accepted = await app.library.acceptTurn({ discussionId: app.id, payload, providerAccount: account })
    await app.library.updateTurn({ turnId: accepted.id, answer: 'Saved', status: 'complete' })
    const { text } = await app.library.exportDiscussions({ conversationId: app.conversation.id })
    const other = await app.library.importConversation({ evidenceId: app.owner.evidenceId, title: 'Different', participants: ['Synthetic Self'],
      sourceParts: ['{"title":"Different","messages":[{"sender_name":"Synthetic Self","content":"Other","timestamp_ms":2}]}'] })
    await expect(app.library.importDiscussions({ conversationId: other.id, text })).rejects.toThrow('library_portability_invalid')
    expect(await app.library.discussions({ conversationId: other.id })).toEqual([])
    const invalid = JSON.parse(text); invalid.threads[0].turns[0].payload.history.push({ ...payload.turn, answer: 'Invented earlier history' })
    await expect(app.library.importDiscussions({ conversationId: app.conversation.id, text: JSON.stringify(invalid) })).rejects.toThrow('library_portability_invalid')
  })
})
