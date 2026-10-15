import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openLibrary } from '../server/library/client.mjs'
import { createImportEngine } from '../server/library/import-engine.mjs'
import { importLimits } from '../server/imports/limits.mjs'
import { validateExport } from '../server/imports/validate.mjs'
import { reconcileRecords, fingerprint } from '../server/imports/matcher.mjs'
import { conversationIdentity } from '../server/imports/conversation-identity.mjs'
const cleanup = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })
const message = (i, extras = {}) => ({ sender_name: i % 2 ? 'Synthetic Self' : 'Synthetic Other', timestamp_ms: i, content: `Generated ${i}`, ...extras })
const source = (messages, { owner = '12345', title = 'Synthetic thread', participants } = {}) => JSON.stringify({ title,
  owner: { id: owner, name: 'Synthetic Self' }, participants: participants ?? [{ name: 'Synthetic Self' }, { name: 'Synthetic Other' }], messages })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'echo-synthetic-engine-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let library = await openLibrary(directory)
  cleanup.push(() => library.close())
  async function prepare(parts, extra = [], conversationDirectory = 'wrap/messages/inbox/synthetic') {
    const jobId = randomUUID(), root = join(directory, 'imports', jobId)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const files = []
    for (const item of [...parts.map((bytes, i) => ({ path: `${conversationDirectory}/message_${i + 1}.json`, bytes })), ...extra]) {
      const id = randomUUID(), bytes = Buffer.from(item.bytes)
      await writeFile(join(root, id), bytes, { mode: 0o600 })
      files.push({ id, path: item.path, size: bytes.length })
    }
    await validateExport(root, files)
    return { jobId, preview: await library.previewImport({ jobId }) }
  }
  return { directory, get library() { return library }, prepare, async reopen() { await library.close(); library = await openLibrary(directory) } }
}
async function allMessages(library, id) { return library.messages({ conversationId: id, limit: 500 }) }

describe('atomic library import and ordered reconciliation', () => {
  it('matches short same-name threads using exact message overlap, preserving IDs', async () => {
    const app = await fixture(), first = await app.prepare([source([message(1)])])
    await app.library.commitImport({ jobId: first.jobId })
    const conversation = (await app.library.conversations())[0]
    const original = (await allMessages(app.library, conversation.id))[0]
    const next = await app.prepare([source([message(1), message(2)])])
    expect(next.preview.ready).toBe(true)
    expect(next.preview.conversations[0].target).toBe(conversation.id)
    const result = await app.library.commitImport({ jobId: next.jobId })
    expect(result.additions).toBe(1); expect(result.matched).toBe(1)
    expect((await allMessages(app.library, conversation.id))[0].id).toBe(original.id)
  })
  it('infers self initially and from existing participant groups on subsequent imports', async () => {
    const app = await fixture()
    const thread = peer => JSON.stringify({ title: peer, participants: [{ name: 'Synthetic Self' }, { name: peer }], messages: [message(1)] })
    const first = await app.prepare([thread('Synthetic A')], [{ path: 'wrap/messages/inbox/another/message_1.json', bytes: thread('Synthetic B') }])
    expect(first.preview.owner).toMatchObject({ label: 'Synthetic Self', needsReview: false })
    const saved = await app.library.commitImport({ jobId: first.jobId })
    const next = await app.prepare([thread('Synthetic C')])
    expect(next.preview.owner).toMatchObject({ label: 'Synthetic Self', needsReview: false })
    expect(next.preview.ready).toBe(true)
    expect(next.preview.conversations[0].candidates).toHaveLength(0)
    expect((await app.library.commitImport({ jobId: next.jobId })).userId).toBe(saved.userId)
    expect(await app.library.conversations()).toHaveLength(3)
  })
  it('derives self for a changed single-thread export from automatically matched existing history', async () => {
    const app = await fixture()
    const thread = records => JSON.stringify({ title: 'Synthetic', participants: [{ name: 'Synthetic Self' }, { name: 'Synthetic Other' }], messages: records })
    const first = await app.prepare([thread([message(1)])])
    const saved = await app.library.commitImport({ jobId: first.jobId, ownerChoice: { label: 'Synthetic Self' } })
    const next = await app.prepare([thread([message(1), message(2)])])
    expect(next.preview.owner).toMatchObject({ label: 'Synthetic Self', needsReview: false })
    expect(next.preview.ready).toBe(true)
    expect((await app.library.commitImport({ jobId: next.jobId })).userId).toBe(saved.userId)
  })
  it('does not infer self from repeated copies of the same participant group', async () => {
    const app = await fixture(), raw = JSON.stringify({ title: 'Synthetic', participants: [{ name: 'Synthetic Self' }, { name: 'Synthetic Other' }], messages: [message(1)] })
    const staged = await app.prepare([raw], [{ path: 'wrap/messages/inbox/another/message_1.json', bytes: raw }])
    expect(staged.preview.owner.needsReview).toBe(true)
  })
  it('does not let matched history override a conflicting explicit owner', async () => {
    const app = await fixture(), first = await app.prepare([source([message(1)])])
    await app.library.commitImport({ jobId: first.jobId })
    const raw = JSON.parse(source([message(1), message(2)]))
    raw.owner = { name: 'Synthetic Other' }
    const staged = await app.prepare([JSON.stringify(raw)])
    expect(staged.preview.conversations[0].target).toBeTruthy()
    expect(staged.preview.owner.needsReview).toBe(true)
    await expect(app.library.commitImport({ jobId: staged.jobId })).rejects.toThrow('import_owner_review')
    expect((await app.library.status()).owner.label).toBe('Synthetic Self')
  })
  it('keeps duplicate same-name candidates and conflicting explicit self in review', async () => {
    const app = await fixture()
    for (let i = 0; i < 2; i++) {
      const staged = await app.prepare([source([message(1), message(i + 2)])])
      await app.library.commitImport({ jobId: staged.jobId, conversations: { [staged.preview.conversations[0].key]: 'separate' } })
    }
    const next = await app.prepare([source([message(1), message(4)])])
    expect(next.preview.ready).toBe(false)
    expect(next.preview.conversations[0].candidates.filter(candidate => candidate.confident)).toHaveLength(2)
    const conflict = JSON.stringify({ title: 'Synthetic thread', participants: [{ name: 'Synthetic Self' }, { name: 'Synthetic Other' }],
      owner: { name: 'Synthetic Other' }, messages: [message(1), message(2)] })
    expect((await app.prepare([conflict])).preview.owner.needsReview).toBe(true)
  })
  it('matches identical repeated-message sequences when export metadata changes', async () => {
    const app = await fixture(), raw = source([message(1), message(1)])
    const first = await app.prepare([raw]); await app.library.commitImport({ jobId: first.jobId })
    const changed = JSON.parse(raw); changed.export_note = 'Synthetic metadata change'
    const next = await app.prepare([JSON.stringify(changed)])
    expect(next.preview.ready).toBe(true)
    const result = await app.library.commitImport({ jobId: next.jobId })
    expect(result.additions).toBe(0); expect(result.matched).toBe(2)
  })
  it('stops history checking when its processing deadline is exceeded', async () => {
    const app = await fixture(), staged = await app.prepare([source([message(1)])])
    await app.library.close()
    const database = new DatabaseSync(join(app.directory, 'library.sqlite'), { readOnly: true })
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const engine = createImportEngine({ db: database, directory: app.directory,
        progress: () => { now = importLimits.duration + 1 } })
      expect(() => engine.previewImport({ jobId: staged.jobId })).toThrow('import_timeout')
      expect(database.prepare('SELECT COUNT(*) AS count FROM owners').get().count).toBe(0)
    } finally { clock.mockRestore(); database.close() }
  })
  it('does not read unrelated message histories just because conversations share self', async () => {
    const app = await fixture()
    const participants = peer => [{ name: 'Synthetic Self' }, { name: peer }]
    for (let i = 0; i < 5; i++) {
      const initial = await app.prepare([source([1,2,3].map(n => message(n)), { participants: participants(`Synthetic peer ${i}`) })])
      await app.library.commitImport({ jobId: initial.jobId, conversations: { [initial.preview.conversations[0].key]: 'separate' } })
    }
    const next = await app.prepare([source([1,2,3,4].map(n => message(n)), { participants: participants('Synthetic peer 0') })])
    await app.library.close()
    const database = new DatabaseSync(join(app.directory, 'library.sqlite'), { readOnly: true })
    let historyRows = 0
    try {
      const db = { prepare(sql) {
        const statement = database.prepare(sql)
        return { get: (...args) => statement.get(...args), all: (...args) => {
          const rows = statement.all(...args)
          historyRows += rows.filter(row => typeof row.source === 'string').length
          return rows
        } }
      } }
      const engine = createImportEngine({ db, directory: app.directory })
      const review = engine.previewImport({ jobId: next.jobId })
      expect(review.ready).toBe(true)
      expect(review.conversations[0].candidates).toHaveLength(5)
      expect(review.conversations[0].candidates.filter(candidate => candidate.confident)).toHaveLength(1)
      expect(historyRows).toBe(3)
    } finally { database.close() }
  })
  it('imports managed media and exact source records, and repeats without changing IDs or revision', async () => {
    const app = await fixture(), raw = source([message(1), message(2, { photos: [{ uri: 'photos/synthetic.png' }] }), message(3)])
    const media = [{ path: 'wrap/messages/inbox/synthetic/photos/synthetic.png', bytes: Buffer.from([137,80,78,71,13,10,26,10]) }]
    const first = await app.prepare([raw], media)
    expect(first.preview.ready).toBe(true)
    const committed = await app.library.commitImport({ jobId: first.jobId })
    expect(committed.additions).toBe(3)
    const conversation = (await app.library.conversations())[0], before = await allMessages(app.library, conversation.id)
    expect((await app.library.readAsset({ id: before[1].attachments[0].assetId })).bytes).toEqual(new Uint8Array(media[0].bytes))
    const repeat = await app.prepare([raw], media)
    const again = await app.library.commitImport({ jobId: repeat.jobId })
    expect(again.additions).toBe(0); expect(again.changed).toBe(0); expect(again.revision).toBe(committed.revision)
    expect((await allMessages(app.library, conversation.id)).map(row => row.id)).toEqual(before.map(row => row.id))
    expect((await app.library.source({ partId: before[0].partId })).sourceJson).toBe(raw)
    expect(await app.library.commitImport({ jobId: repeat.jobId })).toEqual(again)
  })
  it('fills older and newer history through ordered anchors and preserves positions through reordering', async () => {
    const app = await fixture(), first = await app.prepare([source([3,4,5,6].map(i => message(i)))])
    await app.library.commitImport({ jobId: first.jobId })
    const conversation = (await app.library.conversations())[0], before = await allMessages(app.library, conversation.id)
    await app.library.savePosition({ conversationId: conversation.id, messageId: before[1].id, offset: 7 })
    const next = await app.prepare([source([1,2,3,4].map(i => message(i))), source([5,6,7,8].map(i => message(i)))])
    expect(next.preview.ready).toBe(true)
    const result = await app.library.commitImport({ jobId: next.jobId })
    expect(result.additions).toBe(4)
    const after = await allMessages(app.library, conversation.id)
    expect(after.map(row => row.timestamp)).toEqual([1,2,3,4,5,6,7,8])
    expect(after.slice(2,6).map(row => row.id)).toEqual(before.map(row => row.id))
    expect((await app.library.position({ conversationId: conversation.id })).messageId).toBe(before[1].id)
  })
  it('retains changed observations as versions without duplicating timeline messages', async () => {
    const app = await fixture(), first = await app.prepare([source([1,2,3,4,5].map(i => message(i)))])
    await app.library.commitImport({ jobId: first.jobId })
    const conversation = (await app.library.conversations())[0], original = await allMessages(app.library, conversation.id)
    const changedSource = source([1,2,3,4,5].map(i => message(i, i === 3 ? { reactions: [{ actor: 'Synthetic Other', reaction: '❤️' }], unknown: 'retained' } : {})))
    const second = await app.prepare([changedSource])
    const result = await app.library.commitImport({ jobId: second.jobId })
    expect(result.changed).toBe(1); expect(result.additions).toBe(0)
    expect((await allMessages(app.library, conversation.id)).map(row => row.id)).toEqual(original.map(row => row.id))
    const repeat = await app.prepare([changedSource])
    expect(repeat.preview.ready).toBe(true)
    expect((await app.library.commitImport({ jobId: repeat.jobId })).changed).toBe(0)
  })
  it('requires review for a sole legacy conversation candidate without overlapping messages', async () => {
    const app = await fixture(), first = await app.prepare([source([message(1)])])
    await app.library.commitImport({ jobId: first.jobId })
    const conversation = (await app.library.conversations())[0]
    const second = await app.prepare([source([message(10)])])
    expect(second.preview.ready).toBe(false)
    expect(second.preview.conversations[0].target).toBeNull()
    expect(second.preview.conversations[0].candidates).toHaveLength(1)
    await expect(app.library.commitImport({ jobId: second.jobId })).rejects.toThrow('library_reconciliation_required')
    const saved = await app.library.commitImport({ jobId: second.jobId, conversations: { [second.preview.conversations[0].key]: conversation.id } })
    expect(saved.additions).toBe(1)
    expect(await app.library.conversations()).toHaveLength(1)
    expect((await allMessages(app.library, conversation.id)).map(row => row.timestamp)).toEqual([1,10])
    const repeat = await app.prepare([source([message(10)])])
    expect(repeat.preview.ready).toBe(true)
    expect((await app.library.commitImport({ jobId: repeat.jobId })).revision).toBe(saved.revision)
  })
  it('automatically matches sole message candidates without anchors and retains versions, IDs and reading position', async () => {
    const app = await fixture(), folder = 'wrap/messages/inbox/synthetic_1000001'
    const first = await app.prepare([source([message(1), message(2)])], [], folder)
    await app.library.commitImport({ jobId: first.jobId })
    const conversation = (await app.library.conversations())[0], before = await allMessages(app.library, conversation.id)
    await app.library.savePosition({ conversationId: conversation.id, messageId: before[0].id, offset: 7 })
    const raw = source([message(1, { content: 'Synthetic edit' }), message(2, { reactions: [{ actor: 'Synthetic Self', reaction: '❤️' }] })])
    const next = await app.prepare([raw], [], folder)
    expect(next.preview.ready).toBe(true)
    expect(next.preview.conversations[0].messages).toEqual([])
    const saved = await app.library.commitImport({ jobId: next.jobId })
    expect(saved).toMatchObject({ additions: 0, matched: 2, changed: 2 })
    expect((await allMessages(app.library, conversation.id)).map(row => row.id)).toEqual(before.map(row => row.id))
    expect((await app.library.messageVersions({ messageId: before[0].id })).map(version => JSON.parse(version.sourceJson).content)).toEqual(['Generated 1', 'Synthetic edit'])
    expect((await app.library.position({ conversationId: conversation.id })).messageId).toBe(before[0].id)
    const repeat = await app.prepare([raw], [], folder)
    expect(repeat.preview.ready).toBe(true)
    expect(await app.library.commitImport({ jobId: repeat.jobId })).toMatchObject({ additions: 0, changed: 0, revision: saved.revision })
  })
  it('keeps multiple message candidates in review and persists the selected match', async () => {
    const app = await fixture(), folder = 'messages/inbox/synthetic_1000001'
    const first = await app.prepare([source([message(1), message(1)])], [], folder)
    await app.library.commitImport({ jobId: first.jobId })
    const conversation = (await app.library.conversations())[0], before = await allMessages(app.library, conversation.id)
    const next = await app.prepare([source([message(1)])], [], folder), group = next.preview.conversations[0]
    expect(next.preview.ready).toBe(false)
    expect(group.target).toBe(conversation.id)
    expect(group.messages).toHaveLength(1)
    expect(group.messages[0].candidates).toEqual(before.map(row => row.id))
    await expect(app.library.commitImport({ jobId: next.jobId })).rejects.toThrow('library_reconciliation_required')
    const saved = await app.library.commitImport({ jobId: next.jobId, messages: { [group.key]: { 0: before[1].id } } })
    expect(saved).toMatchObject({ additions: 0, matched: 1 })
    expect((await allMessages(app.library, conversation.id)).map(row => row.id)).toEqual(before.map(row => row.id))
    const repeat = await app.prepare([source([message(1)])], [], folder)
    expect(repeat.preview.ready).toBe(true)
    expect((await app.library.commitImport({ jobId: repeat.jobId })).revision).toBe(saved.revision)
  })
  it('reviews competing incoming occurrences instead of assigning the same sole candidate twice', async () => {
    const app = await fixture(), folder = 'messages/inbox/synthetic_1000001'
    const first = await app.prepare([source([message(1)])], [], folder)
    await app.library.commitImport({ jobId: first.jobId })
    const conversation = (await app.library.conversations())[0], original = (await allMessages(app.library, conversation.id))[0]
    const next = await app.prepare([source([message(1), message(1)])], [], folder), group = next.preview.conversations[0]
    expect(next.preview.ready).toBe(false)
    expect(group.messages).toHaveLength(2)
    expect(group.messages.map(item => item.candidates)).toEqual([[original.id], [original.id]])
    await expect(app.library.commitImport({ jobId: next.jobId })).rejects.toThrow('library_reconciliation_required')
    const saved = await app.library.commitImport({ jobId: next.jobId, messages: { [group.key]: { 0: 'separate', 1: original.id } } })
    expect(saved).toMatchObject({ additions: 1, matched: 1 })
    expect(await allMessages(app.library, conversation.id)).toHaveLength(2)
  })
  it('requires review for multiple lookalike threads and persists keep-separate decisions', async () => {
    const app = await fixture()
    for (const i of [1,2]) {
      const staged = await app.prepare([source([message(i)])])
      await app.library.commitImport({ jobId: staged.jobId, conversations: { [staged.preview.conversations[0].key]: 'separate' } })
    }
    const second = await app.prepare([source([message(10)])])
    expect(second.preview.ready).toBe(false)
    expect(second.preview.conversations[0].target).toBeNull()
    expect(second.preview.conversations[0].candidates).toHaveLength(2)
    await expect(app.library.commitImport({ jobId: second.jobId })).rejects.toThrow('library_reconciliation_required')
    const key = second.preview.conversations[0].key
    await app.library.commitImport({ jobId: second.jobId, conversations: { [key]: 'separate' } })
    expect(await app.library.conversations()).toHaveLength(3)
    const repeat = await app.prepare([source([message(10)])])
    expect(repeat.preview.ready).toBe(true)
    expect((await app.library.commitImport({ jobId: repeat.jobId })).additions).toBe(0)
  })
  it('rejects a conflicting export owner and rolls back cancellation', async () => {
    const app = await fixture(), first = await app.prepare([source([message(1)])])
    app.library.cancelImport()
    await expect(app.library.commitImport({ jobId: first.jobId })).rejects.toThrow('import_cancelled')
    app.library.resetImportCancellation()
    expect((await app.library.status()).owner).toBeNull()
    await app.library.commitImport({ jobId: first.jobId })
    await expect(app.prepare([source([message(2)], { owner: '98765' })])).rejects.toThrow('import_owner_mismatch')
    expect(await app.library.conversations()).toHaveLength(1)
  })
  it('requires review when legacy group membership changes and retains both observed memberships', async () => {
    const app = await fixture(), records = [1,2,3,4].map(i => message(i))
    const first = await app.prepare([source(records)])
    await app.library.commitImport({ jobId: first.jobId })
    const conversation = (await app.library.conversations())[0]
    const changed = await app.prepare([source(records, { participants: [{ name: 'Synthetic Self' }, { name: 'Synthetic New Member' }] })])
    expect(changed.preview.ready).toBe(false)
    expect(changed.preview.conversations[0].target).toBeNull()
    await app.library.commitImport({ jobId: changed.jobId, conversations: { [changed.preview.conversations[0].key]: conversation.id } })
    const stored = (await app.library.conversations())[0]
    expect(stored.messageCount).toBe(4)
    expect(stored.participants).toEqual(['Synthetic Self', 'Synthetic Other', 'Synthetic New Member'])
    expect((await app.prepare([source(records, { participants: [{ name: 'Synthetic Self' }, { name: 'Synthetic New Member' }] })])).preview.ready).toBe(true)
  })
  it('requires explicit self review without authoritative owner metadata and preserves userId on correction', async () => {
    const app = await fixture(), raw = JSON.stringify({ title: 'Synthetic', participants: [{ name: 'Synthetic Self' }, { name: 'Synthetic Other' }], messages: [message(1)] })
    const first = await app.prepare([raw])
    expect(first.preview.owner.needsReview).toBe(true)
    const saved = await app.library.commitImport({ jobId: first.jobId, ownerChoice: { label: 'Synthetic Self' } })
    const next = await app.prepare([raw])
    expect(next.preview.owner.needsReview).toBe(false)
    const corrected = await app.library.commitImport({ jobId: next.jobId, ownerChoice: { label: 'Synthetic Other', sameOwner: true } })
    expect(corrected.userId).toBe(saved.userId)
    expect((await app.library.status()).owner.label).toBe('Synthetic Other')
  })
  it('fills missing assets on repeat and retains different bytes as conflicting observations', async () => {
    const app = await fixture(), raw = source([message(1, { photos: [{ uri: 'photos/synthetic.png' }] })])
    const first = await app.prepare([raw]); await app.library.commitImport({ jobId: first.jobId })
    const conversation = (await app.library.conversations())[0]
    expect((await allMessages(app.library, conversation.id))[0].attachments[0].assetId).toBeNull()
    const second = await app.prepare([raw], [{ path: 'wrap/messages/inbox/synthetic/photos/synthetic.png', bytes: 'first' }])
    await app.library.commitImport({ jobId: second.jobId })
    const installed = (await allMessages(app.library, conversation.id))[0].attachments[0].assetId
    expect(installed).toBeTruthy()
    const third = await app.prepare([raw], [{ path: 'wrap/messages/inbox/synthetic/photos/synthetic.png', bytes: 'second' }])
    expect((await app.library.commitImport({ jobId: third.jobId })).changed).toBe(1)
    const retained = (await allMessages(app.library, conversation.id))[0]
    expect(retained.attachments[0].assetId).toBe(installed)
    expect(retained.assetConflictCount).toBe(1)
    expect((await app.library.messageVersions({ messageId: retained.id }))[0].assets).toHaveLength(2)
    const snapshot = await app.library.snapshot({ conversationId: conversation.id })
    expect(JSON.parse(snapshot.sourceParts[0]).provenance[0].occurrences[0].assets).toHaveLength(2)
  })
})

describe('persistent conversation folder identities', () => {
  const stage = (app, folder, records, options) => app.prepare([source(records, options)], [], folder)
  async function seed(app, folder, title = 'Synthetic thread') {
    const first = await stage(app, folder, [message(1)], { title })
    await app.library.commitImport({ jobId: first.jobId })
    return (await app.library.conversations()).find(item => item.title === title)
  }
  it('parses the final numeric suffix without losing underscores, leading zeros or integer precision', () => {
    expect(conversationIdentity('wrapper/messages/inbox/synthetic_with_underscores_900719925474099312345'))
      .toEqual({ handle: 'synthetic_with_underscores', sourceId: '900719925474099312345' })
    expect(conversationIdentity('messages/message_requests/0001000001')).toEqual({ handle: '', sourceId: '0001000001' })
    expect(conversationIdentity('messages/inbox/synthetic')).toBeNull()
    expect(conversationIdentity('messages/../synthetic_1000001')).toBeNull()
  })
  it('merges exact handle-and-ID matches across wrappers and categories without requiring overlap', async () => {
    const app = await fixture(), conversation = await seed(app, 'old/messages/inbox/synthetic_1000001')
    await app.reopen()
    const next = await stage(app, 'new/messages/message_requests/synthetic_1000001', [message(10)])
    expect(next.preview.ready).toBe(true)
    expect(next.preview.conversations[0]).toMatchObject({ target: conversation.id, identity: { handle: 'synthetic', sourceId: '1000001' } })
    expect((await app.library.commitImport({ jobId: next.jobId })).additions).toBe(1)
    expect(await app.library.conversations()).toHaveLength(1)
    expect((await allMessages(app.library, conversation.id)).map(row => row.timestamp)).toEqual([1,10])
  })
  it('prioritizes an ID match over another account with the incoming handle and retains both aliases', async () => {
    const app = await fixture()
    const byId = await seed(app, 'messages/inbox/synthetic_old_1000001', 'Synthetic ID match')
    const byHandle = await seed(app, 'messages/inbox/synthetic_new_1000002', 'Synthetic handle match')
    const next = await stage(app, 'messages/inbox/synthetic_new_1000001', [message(10)])
    const group = next.preview.conversations[0]
    expect(next.preview.ready).toBe(false)
    expect(group.target).toBeNull()
    expect(group.suggested).toBe(byId.id)
    expect(group.candidates.map(item => [item.id,item.match])).toEqual([[byId.id,'id'],[byHandle.id,'handle']])
    await expect(app.library.commitImport({ jobId: next.jobId })).rejects.toThrow('library_reconciliation_required')
    await app.library.commitImport({ jobId: next.jobId, conversations: { [group.key]: byId.id } })
    await app.reopen()
    for (const folder of ['synthetic_old_1000001','synthetic_new_1000001']) {
      const later = await stage(app, `messages/inbox/${folder}`, [message(11)])
      expect(later.preview.ready).toBe(true)
      expect(later.preview.conversations[0].target).toBe(byId.id)
    }
    expect((await allMessages(app.library, byHandle.id)).map(row => row.timestamp)).toEqual([1])
  })
  it('suggests a handle-only match but allows a new conversation and remembers the separate identity', async () => {
    const app = await fixture(), original = await seed(app, 'messages/inbox/synthetic_1000001')
    const next = await stage(app, 'messages/inbox/synthetic_1000002', [message(2)])
    const group = next.preview.conversations[0]
    expect(next.preview.ready).toBe(false)
    expect(group).toMatchObject({ target: null, suggested: original.id })
    expect(group.candidates[0].match).toBe('handle')
    const saved = await app.library.commitImport({ jobId: next.jobId, conversations: { [group.key]: 'separate' } })
    expect(saved.conversations).toBe(1)
    const separate = (await app.library.conversations()).find(item => item.id !== original.id)
    const later = await stage(app, 'messages/inbox/synthetic_1000002', [message(3)])
    expect(later.preview.ready).toBe(true)
    expect(later.preview.conversations[0].target).toBe(separate.id)
    expect((await allMessages(app.library, original.id)).map(row => row.timestamp)).toEqual([1])
  })
  it('allows accepting the handle-only suggestion and reuses the confirmed pair', async () => {
    const app = await fixture(), original = await seed(app, 'messages/inbox/synthetic_1000001')
    const next = await stage(app, 'messages/inbox/synthetic_1000002', [message(2)])
    const group = next.preview.conversations[0]
    await app.library.commitImport({ jobId: next.jobId, conversations: { [group.key]: group.suggested } })
    const later = await stage(app, 'messages/inbox/synthetic_1000002', [message(3)])
    expect(later.preview.ready).toBe(true)
    expect(later.preview.conversations[0].target).toBe(original.id)
  })
  it('creates a new conversation when neither key matches even with identical titles, participants and records', async () => {
    const app = await fixture(), original = await seed(app, 'messages/inbox/synthetic_first_1000001')
    const next = await stage(app, 'messages/inbox/synthetic_second_1000002', [message(1)])
    expect(next.preview.ready).toBe(true)
    expect(next.preview.conversations[0]).toMatchObject({ target: 'separate', candidates: [], suggested: null })
    await app.library.commitImport({ jobId: next.jobId })
    expect(await app.library.conversations()).toHaveLength(2)
    expect(await allMessages(app.library, original.id)).toHaveLength(1)
  })
  it('reviews number-only ID matches, then remembers them without matching unrelated empty handles', async () => {
    const app = await fixture(), original = await seed(app, 'messages/inbox/synthetic_900719925474099312345')
    const next = await stage(app, 'messages/inbox/900719925474099312345', [message(2)])
    const group = next.preview.conversations[0]
    expect(next.preview.ready).toBe(false)
    expect(group).toMatchObject({ target: null, suggested: original.id, identity: { handle: '', sourceId: '900719925474099312345' } })
    expect(group.candidates[0].match).toBe('id')
    await app.library.commitImport({ jobId: next.jobId, conversations: { [group.key]: original.id } })
    const later = await stage(app, 'messages/inbox/900719925474099312345', [message(3)])
    expect(later.preview.ready).toBe(true)
    expect(later.preview.conversations[0].target).toBe(original.id)
    const unrelated = await stage(app, 'messages/inbox/900719925474099312346', [message(1)])
    expect(unrelated.preview.conversations[0]).toMatchObject({ target: 'separate', candidates: [] })
  })
  it('keeps duplicate accepted exact identities in review rather than arbitrarily picking a conversation', async () => {
    const app = await fixture(), folder = 'messages/inbox/synthetic_1000001'
    await seed(app, folder, 'Synthetic first instance')
    const forced = await stage(app, folder, [message(2)], { title: 'Synthetic second instance' })
    await app.library.commitImport({ jobId: forced.jobId, conversations: { [forced.preview.conversations[0].key]: 'separate' } })
    const next = await stage(app, folder, [message(3)])
    expect(next.preview.ready).toBe(false)
    expect(next.preview.conversations[0].target).toBeNull()
    expect(next.preview.conversations[0].candidates.map(item => item.match)).toEqual(['both','both'])
  })
  it('migrates source thread metadata from an older library without replacing conversation or message IDs', async () => {
    const app = await fixture(), raw = JSON.parse(source([message(1)]))
    raw.thread_path = 'inbox/synthetic_1000001'
    const first = await app.prepare([JSON.stringify(raw)], [], 'messages/inbox/synthetic_1000001')
    await app.library.commitImport({ jobId: first.jobId })
    const conversation = (await app.library.conversations())[0], original = (await allMessages(app.library, conversation.id))[0]
    await app.library.close()
    const db = new DatabaseSync(join(app.directory,'library.sqlite'))
    db.exec('DROP TABLE conversation_identities; PRAGMA user_version=5'); db.close()
    await app.reopen()
    expect((await app.library.status()).schemaVersion).toBe(6)
    const next = await stage(app, 'new/messages/inbox/synthetic_1000001', [message(2)])
    expect(next.preview.ready).toBe(true)
    expect(next.preview.conversations[0].target).toBe(conversation.id)
    await app.library.commitImport({ jobId: next.jobId })
    expect((await allMessages(app.library, conversation.id))[0].id).toBe(original.id)
  })
  it('erases identity aliases with the library so they cannot affect a new owner', async () => {
    const app = await fixture()
    await seed(app, 'messages/inbox/synthetic_1000001')
    await app.library.deleteLibrary()
    const next = await stage(app, 'messages/inbox/synthetic_1000001', [message(2)], { owner: '98765' })
    expect(next.preview.ready).toBe(true)
    expect(next.preview.conversations[0]).toMatchObject({ target: 'separate', candidates: [] })
    await app.library.commitImport({ jobId: next.jobId })
    expect(await app.library.conversations()).toHaveLength(1)
  })
})

describe('message occurrence matching', () => {
  const entry = (id, text, timestamp = 1) => ({ id, fingerprint: fingerprint(JSON.stringify({ content: text })), sender: 'Synthetic', timestamp })
  it('preserves repeated occurrences between unique ordered anchors', () => {
    const old = ['a','x','x','b','c'].map((text, i) => entry(String(i), text))
    const next = ['z','a','x','x','b','c','tail'].map(text => entry('', text))
    const result = reconcileRecords(old, next)
    expect([...result.matches.values()].sort()).toEqual(['0','1','2','3','4'])
    expect(result.matches.size).toBe(5)
  })
  it('does not collapse ambiguous repeated occurrences on a fingerprint alone', () => {
    const result = reconcileRecords([entry('one','x'), entry('two','x')], [entry('', 'x')])
    expect(result.matches.size).toBe(0)
    expect(result.ambiguous[0].candidates).toEqual(['one','two'])
  })
})
