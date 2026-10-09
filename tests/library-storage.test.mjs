import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openLibrary } from '../server/library/client.mjs'
import { APPLICATION_ID, SCHEMA_VERSION, migrate } from '../server/library/schema.mjs'

// All database rows, source records, evidence, and bytes in these tests are synthetic.
const cleanup = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'echo-synthetic-library-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let library = await openLibrary(directory)
  cleanup.push(() => library.close())
  return { directory, get library() { return library }, async reopen() { await library.close(); library = await openLibrary(directory) } }
}
const evidence = { label: 'Synthetic Self', evidenceJson: '{"reviewedSelf":"synthetic-owner"}' }
const source = `{
  "title": "Synthetic thread", "participants": [{"name":"Synthetic Self"},{"name":"Synthetic Friend"}],
  "unknown_number": 900719925474099312345,
  "messages": [
    {"sender_name":"Synthetic Friend","timestamp_ms":20,"content":"Repeated","unknown":900719925474099312345},
    {"sender_name":"Synthetic Friend","timestamp_ms":20,"content":"Repeated","unknown":900719925474099312345},
    {"sender_name":"Synthetic Self","timestamp_ms":10,"content":"Earlier"}
  ]
}`
const importInput = evidenceId => ({ evidenceId, title: 'Synthetic thread', participants: ['Synthetic Self', 'Synthetic Friend'], sourceParts: [source] })
async function owner(library) { return library.resolveOwner(evidence) }
async function asset(library, bytes = Buffer.from('synthetic-media')) {
  const upload = await library.beginAsset()
  await library.appendAsset({ id: upload.id, bytes })
  return library.finishAsset({ id: upload.id })
}

describe('durable library worker', () => {
  it('persists exact source JSON, repeated occurrences, managed bytes and reading positions across restart', async () => {
    const app = await fixture()
    const identity = await owner(app.library)
    const stored = await asset(app.library)
    const input = { ...importInput(identity.evidenceId), attachments: [
      { part: 0, index: 0, slot: 0, kind: 'image', assetId: stored.id },
      { part: 0, index: 1, slot: 0, kind: 'file', assetId: null },
    ] }
    const conversation = await app.library.importConversation(input)
    const first = await app.library.messages({ conversationId: conversation.id, limit: 1 })
    expect(first.map(message => message.text)).toEqual(['Earlier'])
    const next = await app.library.messages({ conversationId: conversation.id, after: first[0].ordinal })
    expect(next.map(message => message.text)).toEqual(['Repeated', 'Repeated'])
    expect(next[0].id).not.toBe(next[1].id)
    expect(next[0].versionId).not.toBe(next[1].versionId)
    expect(next[0].userId).toBe(identity.userId)
    expect(next[0].attachments[0].assetId).toBe(stored.id)
    expect(next[1].attachments[0].assetId).toBeNull()
    const part = await app.library.source({ partId: next[0].partId })
    expect(part.sourceJson).toBe(source)
    await app.library.savePosition({ conversationId: conversation.id, messageId: next[0].id, offset: 12 })
    const before = await app.library.status()
    await app.reopen()
    expect(await app.library.status()).toEqual(before)
    expect(await app.library.position({ conversationId: conversation.id })).toEqual({ userId: identity.userId, conversationId: conversation.id, messageId: next[0].id, offset: 12 })
    expect(await app.library.messages({ conversationId: conversation.id, after: first[0].ordinal })).toEqual(next)
    expect(Buffer.from((await app.library.readAsset({ id: stored.id })).bytes).toString()).toBe('synthetic-media')
    expect((await app.library.source({ partId: next[0].partId })).sourceJson).toBe(source)
    expect((await stat(join(app.directory, 'library.sqlite'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(app.directory, 'media'))).mode & 0o777).toBe(0o700)
  })

  it('keeps owner identity stable through explicit corrections and rejects unconfirmed or mismatched ownership', async () => {
    const { library } = await fixture()
    await expect(library.importConversation(importInput(randomUUID()))).rejects.toThrow('library_owner_required')
    const resolved = await owner(library)
    await expect(owner(library)).rejects.toThrow('library_owner_mismatch')
    await expect(library.resolveOwner({ ...evidence, expectedUserId: randomUUID() })).rejects.toThrow('library_owner_mismatch')
    const corrected = await library.resolveOwner({ ...evidence, label: 'Corrected Synthetic Self', expectedUserId: resolved.userId })
    expect(corrected.userId).toBe(resolved.userId)
    expect(corrected.evidenceId).not.toBe(resolved.evidenceId)
    await expect(library.importConversation(importInput(randomUUID()))).rejects.toThrow('library_owner_mismatch')
    expect((await library.status()).owner.label).toBe('Corrected Synthetic Self')
  })

  it('does not use names, message fingerprints, or caller userId to identify or authorize records', async () => {
    const left = await fixture(), right = await fixture()
    const a = await owner(left.library), b = await owner(right.library)
    expect(a.userId).not.toBe(b.userId)
    const first = await left.library.importConversation(importInput(a.evidenceId))
    const second = await left.library.importConversation(importInput(a.evidenceId))
    expect(first.id).not.toBe(second.id)
    const foreignAsset = await asset(right.library)
    await expect(left.library.readAsset({ id: foreignAsset.id, userId: b.userId })).rejects.toThrow('library_not_found')
    await expect(right.library.messages({ conversationId: first.id, userId: a.userId })).rejects.toThrow('library_not_found')
    await expect(right.library.importConversation(importInput(a.evidenceId))).rejects.toThrow('library_owner_mismatch')
    const message = (await left.library.messages({ conversationId: first.id }))[0]
    await expect(left.library.savePosition({ conversationId: second.id, messageId: message.id })).rejects.toThrow('library_not_found')
  })

  it('makes explicitly resolved identical imports a no-op, including reordered parts, and refuses changed observations', async () => {
    const { library } = await fixture()
    const resolved = await owner(library)
    const older = '{"title":"Synthetic thread","messages":[{"sender_name":"Synthetic Self","content":"Old","timestamp_ms":1}]}'
    const input = { ...importInput(resolved.evidenceId), sourceParts: [source, older] }
    const imported = await library.importConversation(input)
    const before = await library.status()
    const rows = await library.messages({ conversationId: imported.id })
    expect((await library.importConversation({ ...input, conversationId: imported.id, sourceParts: [older, source] })).changed).toBe(false)
    expect(await library.status()).toEqual(before)
    expect(await library.messages({ conversationId: imported.id })).toEqual(rows)
    await expect(library.importConversation({ ...input, conversationId: imported.id, sourceParts: [source.replace('Repeated', 'Changed'), older] })).rejects.toThrow('library_reconciliation_required')
    expect(await library.messages({ conversationId: imported.id })).toEqual(rows)
  })

  it('rejects malformed sources, invalid references and size violations without publishing partial history', async () => {
    const { library } = await fixture()
    const resolved = await owner(library)
    const input = importInput(resolved.evidenceId)
    const before = await library.status()
    for (const sourceParts of [[source, '{'], [source, '{"title":"Synthetic","messages":[null]}'], [source, source]]) {
      await expect(library.importConversation({ ...input, sourceParts })).rejects.toThrow()
    }
    await expect(library.importConversation({ ...input, attachments: [{ part: 0, index: 0, slot: 0, kind: 'image', assetId: randomUUID() }] })).rejects.toThrow('library_not_found')
    await expect(library.importConversation({ ...input, sourceParts: [' '.repeat(8 * 1024 * 1024 + 1)] })).rejects.toThrow()
    expect(await library.status()).toEqual(before)
    expect(await library.conversations()).toEqual([])
  })

  it('deduplicates installed bytes, supports bounded reads, and cancels unfinished media', async () => {
    const { library } = await fixture()
    await owner(library)
    const first = await asset(library), second = await asset(library)
    expect(second.id).toBe(first.id)
    expect(Buffer.from((await library.readAsset({ id: first.id, offset: 2, length: 4 })).bytes).toString()).toBe('nthe')
    await expect(library.readAsset({ id: first.id, length: 1024 * 1024 + 1 })).rejects.toThrow('library_invalid_input')
    const upload = await library.beginAsset()
    await expect(library.beginAsset()).rejects.toThrow('library_busy')
    await expect(library.appendAsset({ id: upload.id, bytes: Buffer.alloc(1024 * 1024 + 1) })).rejects.toThrow('library_limit')
    await library.appendAsset({ id: upload.id, bytes: Buffer.from('unfinished') })
    await library.cancelAsset({ id: upload.id })
    await expect(library.finishAsset({ id: upload.id })).rejects.toThrow('library_upload_invalid')
    await expect(library.readAsset({ id: upload.id })).rejects.toThrow('library_not_found')
  })

  it('recovers abandoned staging and orphan installed bytes without deleting referenced media', async () => {
    const app = await fixture()
    await owner(app.library)
    const stored = await asset(app.library)
    await app.library.close()
    const orphan = createHash('sha256').update('synthetic orphan').digest('hex')
    await writeFile(join(app.directory, 'staging', `${randomUUID()}.part`), 'synthetic interrupted copy', { mode: 0o600 })
    await writeFile(join(app.directory, 'media', orphan), 'synthetic orphan', { mode: 0o600 })
    await app.reopen()
    expect(await readdir(join(app.directory, 'staging'))).toEqual([])
    expect(await readdir(join(app.directory, 'media'))).toHaveLength(1)
    expect(Buffer.from((await app.library.readAsset({ id: stored.id })).bytes).toString()).toBe('synthetic-media')
  })

  it('refuses a newer schema without changing its database or cleaning its staging', async () => {
    const app = await fixture()
    await owner(app.library)
    await app.library.close()
    const db = new DatabaseSync(join(app.directory, 'library.sqlite'))
    db.exec('PRAGMA user_version=999'); db.close()
    const staging = join(app.directory, 'staging', `${randomUUID()}.part`)
    await writeFile(staging, 'synthetic future staging', { mode: 0o600 })
    const before = await readFile(join(app.directory, 'library.sqlite'))
    await expect(openLibrary(app.directory)).rejects.toThrow('library_schema_newer')
    expect(await readFile(join(app.directory, 'library.sqlite'))).toEqual(before)
    expect(await readFile(staging, 'utf8')).toBe('synthetic future staging')
  })

  it('rejects unsafe files and reports missing committed media without leaking paths', async () => {
    const app = await fixture()
    await owner(app.library)
    const stored = await asset(app.library)
    const [name] = await readdir(join(app.directory, 'media'))
    await rm(join(app.directory, 'media', name))
    await expect(app.library.readAsset({ id: stored.id })).rejects.toThrow('library_asset_unavailable')
    await app.library.close()
    await writeFile(join(app.directory, 'outside'), 'synthetic', { mode: 0o600 })
    await symlink(join(app.directory, 'outside'), join(app.directory, 'media', name))
    await expect(openLibrary(app.directory)).rejects.toThrow('library_permissions')
  })

  it('serializes library owners independently of launcher-state directories', async () => {
    const app = await fixture()
    await expect(openLibrary(app.directory)).rejects.toThrow('service_locked')
    await app.reopen()
    expect((await app.library.status()).schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('rolls back an import when a database write fails after creating the conversation and provenance', async () => {
    const app = await fixture()
    const resolved = await owner(app.library)
    const before = await app.library.status()
    await app.library.close()
    const db = new DatabaseSync(join(app.directory, 'library.sqlite'))
    db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'synthetic private diagnostic'); END;")
    db.close()
    await app.reopen()
    await expect(app.library.importConversation(importInput(resolved.evidenceId))).rejects.toThrow('library_storage_failed')
    expect(await app.library.status()).toEqual(before)
    expect(await app.library.conversations()).toEqual([])
    await app.library.close()
    const check = new DatabaseSync(join(app.directory, 'library.sqlite'))
    try {
      expect(check.prepare('SELECT COUNT(*) AS n FROM imports').get().n).toBe(0)
      expect(check.prepare('SELECT COUNT(*) AS n FROM source_parts').get().n).toBe(0)
    } finally { check.close() }
  })

  it('reclaims installed bytes if committing the asset reference fails', async () => {
    const app = await fixture()
    await owner(app.library)
    await app.library.close()
    const db = new DatabaseSync(join(app.directory, 'library.sqlite'))
    db.exec("CREATE TRIGGER synthetic_asset_failure BEFORE INSERT ON assets BEGIN SELECT RAISE(ABORT, 'synthetic'); END;")
    db.close()
    await app.reopen()
    await expect(asset(app.library)).rejects.toThrow('library_storage_failed')
    expect(await readdir(join(app.directory, 'media'))).toHaveLength(1)
    await app.reopen()
    expect(await readdir(join(app.directory, 'media'))).toEqual([])
  })
})

describe('SQLite invariants', () => {
  it('rolls a failed migration back without advancing its schema or preserving half-created tables', () => {
    const db = new DatabaseSync(':memory:')
    try {
      expect(() => migrate(db, [{ version: 1, sql: 'CREATE TABLE partial (id TEXT); INSERT INTO missing VALUES (1);' }])).toThrow('library_migration_failed')
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(0)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get()).toBeUndefined()
      migrate(db)
      expect(db.prepare('PRAGMA application_id').get().application_id).toBe(APPLICATION_ID)
    } finally { db.close() }
  })

  it('enforces owner-consistent foreign keys below the API layer', async () => {
    const app = await fixture()
    const resolved = await owner(app.library)
    const imported = await app.library.importConversation(importInput(resolved.evidenceId))
    await app.library.close()
    const db = new DatabaseSync(join(app.directory, 'library.sqlite'))
    try {
      db.exec('PRAGMA foreign_keys=ON')
      expect(() => db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), randomUUID(), imported.id, 99, 'Synthetic', 'Synthetic', 1)).toThrow()
      const raw = db.prepare('SELECT source_json FROM message_versions WHERE source_json LIKE ?').get('%unknown%')
      expect(raw.source_json).toContain('900719925474099312345')
      expect(() => db.prepare('UPDATE message_versions SET source_json = ?').run('{}')).toThrow()
    } finally { db.close() }
  })
})
