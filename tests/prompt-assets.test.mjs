import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openLibrary } from '../server/library/client.mjs'
import { validateExport } from '../server/imports/validate.mjs'
import { prepareContext } from '../server/library/prepare-context.mjs'
import { createAnalysisJobs } from '../server/library/analysis-jobs.mjs'
import { analysisRequest, validateAnalysis } from '../shared/analysis-policy.mjs'
import { validateAssetChoices } from '../shared/prompt-assets.mjs'
import { timeWindows } from '../shared/context-windows.mjs'

const cleanup = [], account = 'a'.repeat(64), day = 86_400_000
const message = (timestamp_ms, content = `Synthetic record ${timestamp_ms}`) => ({ sender_name: 'Synthetic Self', timestamp_ms, content })
const records = asset => asset.sourceParts.flatMap(part => Object.values(JSON.parse(part).messages))
const choice = (conversationId, scope = 'week') => ({ kind: 'conversation', id: randomUUID(), conversationId, scope })
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'echo-synthetic-assets-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let library = await openLibrary(directory)
  cleanup.push(() => library.close())
  async function thread(key, messages = [message(1)], title = 'Synthetic conversation') {
    const jobId = randomUUID(), root = join(directory, 'imports', jobId), id = randomUUID()
    await mkdir(root, { recursive: true, mode: 0o700 })
    const source = JSON.stringify({ owner: { id: '100', name: 'Synthetic Self' }, title, participants: [{ name: 'Synthetic Self' }, { name: 'Synthetic Peer' }], messages })
    await writeFile(join(root, id), source, { mode: 0o600 })
    await validateExport(root, [{ id, path: `messages/inbox/${key}/message_1.json`, size: Buffer.byteLength(source) }])
    const before = new Set((await library.status()).owner ? (await library.conversations()).map(row => row.id) : [])
    const preview = await library.previewImport({ jobId })
    await library.commitImport({ jobId })
    const target = preview.conversations[0].target
    return target && target !== 'separate' ? target : (await library.conversations()).find(row => !before.has(row.id)).id
  }
  const primary = await thread('primary_1000', [message(100 * day, 'Primary evidence only')]), discussionId = randomUUID()
  await library.saveDiscussion({ id: discussionId, conversationId: primary, title: 'New discussion', draft: 'Did I omit anything?', scope: 'week' })
  const input = (assets = [], extra = {}) => ({ discussionId, question: 'Did I omit anything?', scope: 'week', focus: [], model: 'synthetic-model', assets, ...extra })
  async function prepare(assets = [], extra = {}) { return (await prepareContext(library, input(assets, extra))).payload }
  async function complete(payload, assets = []) {
    const turn = await library.acceptTurn({ discussionId, payload, providerAccount: account, input: input(assets, { question: payload.turn.question }) })
    await library.updateTurn({ turnId: turn.id, answer: 'Synthetic comparison', status: 'complete' })
    return turn
  }
  return { directory, primary, discussionId, get library() { return library }, thread, input, prepare, complete,
    async reopen() { await library.close(); library = await openLibrary(directory) } }
}

describe('explicit conversation assets', () => {
  it.each(Object.keys(timeWindows))('resolves %s independently at the attached archive boundary', async scope => {
    const app = await fixture(), duration = timeWindows[scope], end = duration * 4
    const other = await app.thread('other_2000', [message(0, 'Far outside'), message(end - duration - 1, 'Outside'), message(end - duration, 'Inclusive boundary'), message(end, 'Latest attachment')])
    const payload = await app.prepare([choice(other, scope)])
    expect(payload.turn.context).toMatchObject({ scope: 'week' })
    expect(payload.sourceParts.join('')).toContain('Primary evidence only')
    expect(payload.sourceParts.join('')).not.toContain('Latest attachment')
    expect(records(payload.turn.assets[0]).map(row => row.content)).toEqual(['Inclusive boundary', 'Latest attachment'])
    expect(Object.keys(JSON.parse(payload.turn.assets[0].sourceParts[0]))).toEqual(['messages'])
    expect(Object.keys(payload.turn.assets[0].referenceMap)).toHaveLength(2)
  })

  it('keeps identical titles separate, excludes other discussions, notes and media contents, and labels provider evidence', async () => {
    const app = await fixture(), one = await app.thread('one_2000'), two = await app.thread('two_3000', [message(2, 'Independent second source')])
    await app.library.saveConversationContext({ conversationId: one, revision: 0, markdown: 'Unshared attached-source note' })
    const id = randomUUID()
    await app.library.saveDiscussion({ id, conversationId: one, title: 'Unshared source discussion', draft: 'Unshared source question', scope: 'week' })
    const choices = [choice(one), choice(two, 'full')], payload = await app.prepare(choices), outgoing = analysisRequest(payload)
    expect(payload.turn.assets.map(asset => asset.conversationId)).toEqual([one, two])
    expect(payload.turn.images).toEqual([])
    expect(JSON.parse(payload.turn.assets[1].sourceParts[0]).provenance).toBeDefined()
    const text = JSON.stringify(outgoing)
    expect(text).toContain(`a${choices[0].id}:p1:m1`)
    expect(text).toContain(`a${choices[1].id}:p1:m1`)
    expect(text).not.toContain('Unshared attached-source note')
    expect(text).not.toContain('Unshared source question')
    expect(outgoing.tools).toEqual([])
    expect(outgoing.instructions).toContain('Keep their attribution separate')
    expect(validateAnalysis(payload)).toEqual(payload)
  })

  it('persists asset-only drafts, clears accepted choices, and retains immutable history across imports and restart', async () => {
    const app = await fixture(), other = await app.thread('other_2000'), assets = [choice(other)]
    const saved = await app.library.saveDiscussion({ id: app.discussionId, conversationId: app.primary, title: 'New discussion', draft: '', scope: 'week', assets, draftRevision: 1 })
    await app.reopen()
    expect((await app.library.discussion({ discussionId: app.discussionId })).assets).toEqual(assets)
    await expect(app.library.saveDiscussion({ ...saved, draftRevision: 1, assets: [] })).rejects.toThrow('library_draft_conflict')
    await app.library.saveDiscussion({ ...saved, draft: 'Did I omit anything?' })
    const payload = await app.prepare(assets)
    await app.complete(payload, assets)
    const original = (await app.library.discussion({ discussionId: app.discussionId })).turns[0]
    expect((await app.library.discussion({ discussionId: app.discussionId })).assets).toEqual([])
    await app.thread('other_2000', [message(1), message(2, 'New attachment evidence')])
    const followup = await app.prepare([], { question: 'Follow-up without attachments' })
    expect(followup.turn.context).toEqual({ scope: 'discussion' })
    expect(followup.turn.assets).toEqual([])
    expect(followup.history[0].assets).toEqual(payload.turn.assets)
    expect(JSON.stringify(followup)).not.toContain('New attachment evidence')
    await app.complete(followup)
    const reattached = await app.prepare([choice(other, 'full')])
    expect(records(reattached.turn.assets[0]).map(row => row.content)).toContain('New attachment evidence')
    await app.reopen()
    expect((await app.library.discussion({ discussionId: app.discussionId })).turns[0]).toEqual(original)
  })

  it('rejects relevant source races and tampered snapshots before dispatch without clearing drafts', async () => {
    const app = await fixture(), other = await app.thread('other_2000'), assets = [choice(other)]
    let dispatches = 0
    const jobs = createAnalysisJobs({ library: app.library, provider: { prepareJob: async () => ({ providerAccount: account, run: async () => { dispatches++ } }) } })
    cleanup.push(() => jobs.close())
    const { payload } = await jobs.prepare({}, app.input(assets))
    for (const changed of [
      { ...payload.turn.assets[0], scope: 'full' },
      { ...payload.turn.assets[0], title: 'Forged label' },
      { ...payload.turn.assets[0], referenceMap: { 'p1:m1': randomUUID() } },
    ]) {
      await expect(jobs.accept({}, { discussionId: app.discussionId, payload: { ...payload, turn: { ...payload.turn, assets: [changed] } } })).rejects.toThrow('library_context_changed')
      await expect(app.library.acceptTurn({ discussionId: app.discussionId, providerAccount: account, payload: { ...payload, turn: { ...payload.turn, assets: [changed] } }, input: app.input(assets) })).rejects.toThrow('library_context_changed')
    }
    await app.thread('other_2000', [message(1), message(2)])
    await expect(jobs.accept({}, { discussionId: app.discussionId, payload })).rejects.toThrow('library_context_changed')
    expect(dispatches).toBe(0)
    expect((await app.library.discussion({ discussionId: app.discussionId })).draft).toBe('Did I omit anything?')
    expect((await app.library.discussion({ discussionId: app.discussionId })).turns).toEqual([])
  })

  it('preserves concurrently edited drafts and gives retained choices a fresh namespace for the next Send', async () => {
    const app = await fixture(), other = await app.thread('other_2000'), assets = [choice(other)]
    const saved = await app.library.saveDiscussion({ id: app.discussionId, conversationId: app.primary, title: 'New discussion', draft: 'Did I omit anything?', scope: 'week', assets, draftRevision: 1 })
    const payload = await app.prepare(assets)
    await app.library.saveDiscussion({ ...saved, draft: 'A newer draft from another synthetic tab', assets: [{ ...assets[0], scope: 'month' }] })
    await app.complete(payload, assets)
    const retained = await app.library.discussion({ discussionId: app.discussionId })
    expect(retained.draft).toBe('A newer draft from another synthetic tab')
    expect(retained.assets[0]).toMatchObject({ conversationId: other, scope: 'month' })
    expect(retained.assets[0].id).not.toBe(assets[0].id)
    const next = await app.prepare(retained.assets, { question: retained.draft })
    expect(next.history[0].assets).toEqual(payload.turn.assets)
    await app.complete(next, retained.assets)
    expect((await app.library.discussion({ discussionId: app.discussionId })).assets).toEqual([])
  })

  it('tolerates unrelated imports and deduplicates accepted requests without dispatching again', async () => {
    const app = await fixture(), other = await app.thread('other_2000'), assets = [choice(other)]
    let dispatches = 0
    const jobs = createAnalysisJobs({ library: app.library, provider: { prepareJob: async () => ({ providerAccount: account, run: async ({ onEvent }) => { dispatches++; await onEvent({ type: 'complete' }) } }) } })
    cleanup.push(() => jobs.close())
    const { payload } = await jobs.prepare({}, app.input(assets))
    expect(dispatches).toBe(0)
    await app.thread('unrelated_3000', [message(3)])
    expect((await jobs.accept({}, { discussionId: app.discussionId, payload })).accepted).toBe(true)
    await expect.poll(() => dispatches).toBe(1)
    expect((await jobs.accept({}, { discussionId: app.discussionId, payload })).accepted).toBe(false)
    expect(dispatches).toBe(1)
  })

  it('validates boundaries, missing and foreign sources, and undated context without silent fallback', async () => {
    const app = await fixture(), other = await app.thread('undated_2000', [message(null)])
    await expect(app.prepare([choice(other)])).rejects.toThrow('library_context_timestamps_unavailable')
    expect((await app.prepare([choice(other, 'full')])).turn.assets).toHaveLength(1)
    await expect(app.prepare([choice(app.primary)])).rejects.toThrow('library_invalid_input')
    await expect(app.prepare([choice(other), choice(other)])).rejects.toThrow('library_invalid_input')
    await expect(app.prepare([choice(randomUUID())])).rejects.toThrow('library_not_found')
    await expect(app.prepare([choice(other, 'selected')])).rejects.toThrow('library_invalid_input')
    expect(() => validateAssetChoices(Array.from({ length: 11 }, () => choice(randomUUID())))).toThrow('invalid_prompt_assets')
    const second = await fixture(), foreign = await second.thread('foreign_4000')
    await expect(app.prepare([choice(foreign)])).rejects.toThrow('library_not_found')
  })

  it('counts historical and current asset sources toward the combined transfer limit', async () => {
    const app = await fixture(), other = await app.thread('other_2000'), initial = await app.prepare([choice(other)])
    await app.complete(initial, initial.turn.assets)
    const next = await app.prepare([choice(other)])
    const oversized = structuredClone(next), asset = oversized.turn.assets[0]
    asset.sourceParts = [JSON.stringify({ messages: { 0: message(1, 'x'.repeat(24_000_000)) } })]
    asset.referenceMap = { 'p1:m1': randomUUID() }
    asset.contextVersion = createHash('sha256').update(JSON.stringify(asset.sourceParts)).digest('hex')
    expect(() => validateAnalysis(oversized)).toThrow('context_too_large')
    oversized.turn.assets = []
    oversized.history[0].assets = [asset]
    expect(() => validateAnalysis(oversized)).toThrow('context_too_large')
  })

  it('migrates version-seven drafts to empty choices without inventing historical snapshots', async () => {
    const app = await fixture()
    const payload = await app.prepare()
    delete payload.turn.assets
    await app.complete(payload)
    await app.library.close()
    const db = new DatabaseSync(join(app.directory, 'library.sqlite'))
    db.exec('ALTER TABLE discussions DROP COLUMN assets_json; PRAGMA user_version=7')
    db.close()
    await app.reopen()
    const saved = await app.library.discussion({ discussionId: app.discussionId })
    expect(saved.assets).toEqual([])
    expect(saved.turns[0].assets).toBeUndefined()
  })
})
