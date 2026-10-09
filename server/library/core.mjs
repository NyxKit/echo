import { DatabaseSync } from 'node:sqlite'
import { cacheStatements } from './sql.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { APPLICATION_ID, SCHEMA_VERSION, migrate } from './schema.mjs'
import { privateDirectory, privateFile, recoverFiles, syncDirectory } from './files.mjs'
import { createMediaStore } from './media.mjs'
import { createImportEngine } from './import-engine.mjs'
import { createDiscussions } from './discussions.mjs'
import { thumbnailReference } from '../imports/validate.mjs'
import { sourceMessageRecords, sourceMetadata } from '../../shared/analysis-source.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const fail = (code = 'library_invalid_input') => { throw new Error(code) }
const text = (value, max = 4096) => { if (typeof value !== 'string' || value.length > max) fail(); return value }
const uuid = value => { if (!validId(value)) fail(); return value }
function json(value, limit) {
  text(value, limit)
  if (Buffer.byteLength(value) > limit) fail('library_limit')
  try { return JSON.parse(value) } catch { fail() }
}
function pageSize(value = 100) { if (!Number.isInteger(value) || value < 1 || value > 500) fail(); return value }
function decode(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0080-\u00ff]+/g, sequence => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(sequence, c => c.charCodeAt(0))) }
    catch { return sequence }
  })
}

export function openCore(directory, { cancellation, importProgress } = {}) {
  privateDirectory(directory)
  const path = join(directory, 'library.sqlite')
  const existing = privateFile(path, true)
  for (const suffix of ['-journal', '-wal', '-shm']) privateFile(`${path}${suffix}`, true)
  // Inspect compatibility read-only before changing pragmas, files, or recovery state.
  if (existing?.size) {
    const check = new DatabaseSync(path, { readOnly: true })
    try {
      if (check.prepare('PRAGMA user_version').get().user_version > SCHEMA_VERSION) fail('library_schema_newer')
      const appId = check.prepare('PRAGMA application_id').get().application_id
      if (appId !== APPLICATION_ID && (appId !== 0 || check.prepare('PRAGMA user_version').get().user_version !== 0 ||
          check.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get())) fail('library_invalid_database')
    } finally { check.close() }
  }
  if (!existing) closeSync(openSync(path, 'wx', 0o600))
  const db = cacheStatements(new DatabaseSync(path, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false }))
  try {
    db.exec('PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=1000;')
    migrate(db)
    privateDirectory(join(directory, 'media'))
    privateDirectory(join(directory, 'staging'))
    syncDirectory(directory)
    if (!db.prepare('SELECT cleanup_required FROM library_state').get().cleanup_required) recoverFiles(directory, db)
  } catch (error) { db.close(); throw error }
  const get = (sql, ...values) => db.prepare(sql).get(...values)
  const all = (sql, ...values) => db.prepare(sql).all(...values)
  const run = (sql, ...values) => db.prepare(sql).run(...values)
  const revision = () => get('SELECT revision FROM library_state').revision
  const advance = () => { run('UPDATE library_state SET revision = revision + 1'); return revision() }
  const owner = () => get('SELECT user_id AS userId, label FROM owners') ?? fail('library_owner_required')
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const media = createMediaStore(directory, db, owner)
  function conversation(id) {
    const row = get('SELECT id, user_id AS userId, title, participants_json, signature, category FROM conversations WHERE user_id = ? AND id = ?', owner().userId, uuid(id))
    if (!row) fail('library_not_found')
    return row
  }
  function publicConversation(row) {
    return { id: row.id, userId: row.userId, title: row.title, participants: JSON.parse(row.participants_json), category: row.category ?? 'Inbox',
      pictures: all('SELECT name,asset_id AS assetId FROM conversation_pictures WHERE user_id=? AND conversation_id=?', row.userId, row.id),
      messageCount: get('SELECT COUNT(*) AS count FROM messages WHERE user_id=? AND conversation_id=?', row.userId, row.id).count,
      preview: get('SELECT text, timestamp FROM messages WHERE user_id=? AND conversation_id=? ORDER BY ordinal DESC LIMIT 1', row.userId, row.id) ?? null }
  }
  function importConversation(input) {
    const { evidenceId, conversationId, sourceParts, title, participants, attachments = [] } = input
    const userId = owner().userId
    if (!get('SELECT 1 FROM owner_evidence WHERE user_id = ? AND id = ?', userId, uuid(evidenceId))) fail('library_owner_mismatch')
    text(title)
    if (!Array.isArray(participants) || participants.length > 1000) fail()
    participants.forEach(value => text(value))
    if (Buffer.byteLength(JSON.stringify(participants)) > 32_768) fail('library_limit')
    if (!Array.isArray(sourceParts) || !sourceParts.length || sourceParts.length > 256 || !Array.isArray(attachments) || attachments.length > 100_000) fail('library_limit')
    let total = 0, count = 0
    const records = []
    const sources = sourceParts.map((source, part) => {
      const parsed = json(source, 8 * 1024 * 1024)
      total += Buffer.byteLength(source)
      if (total > 32 * 1024 * 1024) fail('library_limit')
      if (!object(parsed) || !Array.isArray(parsed.messages) || (!Array.isArray(parsed.participants) && typeof parsed.title !== 'string')) fail()
      const rawRecords = sourceMessageRecords(source)
      for (let index = 0; index < rawRecords.length; index++) {
        const message = parsed.messages[index]
        if (!object(message) || !['sender_name', 'content', 'photos', 'videos', 'audio_files', 'files', 'gifs', 'sticker', 'share', 'is_unsent', 'type'].some(key => key in message)) fail()
        if (++count > 100_000) fail('library_limit')
        records.push({ part, index, source: rawRecords[index], id: randomUUID(), versionId: randomUUID(),
          sender: decode(message.sender_name) || 'Unknown sender', text: decode(message.content),
          timestamp: Number.isSafeInteger(message.timestamp_ms) && Math.abs(message.timestamp_ms) <= 8.64e15 ? message.timestamp_ms : null })
      }
      return { id: randomUUID(), digest: hash(source), source, count: parsed.messages.length }
    })
    if (new Set(sources.map(source => source.digest)).size !== sources.length) fail('library_ambiguous_source')
    const slots = new Set()
    const bindings = attachments.map(binding => {
      if (!object(binding) || !Number.isInteger(binding.part) || !Number.isInteger(binding.index) ||
          binding.index < 0 || binding.index >= (sources[binding.part]?.count ?? 0) ||
          !Number.isInteger(binding.slot) || binding.slot < 0 || binding.slot > 1000 || !['image', 'audio', 'video', 'file'].includes(binding.kind)) fail()
      const key = `${binding.part}:${binding.index}:${binding.slot}`
      if (slots.has(key)) fail()
      slots.add(key)
      if (binding.assetId !== null) {
        uuid(binding.assetId)
        if (!get('SELECT 1 FROM assets WHERE user_id = ? AND id = ?', userId, binding.assetId)) fail('library_not_found')
      }
      return { part: binding.part, index: binding.index, slot: binding.slot, kind: binding.kind, assetId: binding.assetId }
    })
    const signature = hash(JSON.stringify({
      parts: sources.map(source => source.digest).sort(),
      attachments: bindings.map(binding => [sources[binding.part].digest, binding.index, binding.slot, binding.kind, binding.assetId]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    }))
    if (conversationId !== undefined) {
      const previous = conversation(conversationId)
      if (previous.signature !== signature) fail('library_reconciliation_required')
      return { ...publicConversation(previous), revision: revision(), changed: false }
    }
    records.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.part - b.part || a.index - b.index)
    return transaction(() => {
      const id = randomUUID(), importId = randomUUID(), nextRevision = advance()
      run('INSERT INTO conversations (id, user_id, title, participants_json, signature) VALUES (?, ?, ?, ?, ?)', id, userId, title, JSON.stringify(participants), signature)
      run('INSERT INTO imports VALUES (?, ?, ?, ?, ?)', importId, userId, id, evidenceId, nextRevision)
      sources.forEach((source, ordinal) => {
        run('INSERT INTO source_parts VALUES (?, ?, ?, ?, ?, ?, ?)', source.id, userId, id, importId, source.digest, source.source, ordinal)
        run('INSERT INTO import_source_parts VALUES (?,?,?,?)', userId, importId, source.id, ordinal)
      })
      const identities = new Map()
      records.forEach((record, ordinal) => {
        run('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)', record.id, userId, id, ordinal, record.sender, record.text, record.timestamp)
        run('INSERT INTO message_versions VALUES (?, ?, ?, ?, ?)', record.versionId, userId, id, record.id, record.source)
        run('INSERT INTO source_occurrences VALUES (?, ?, ?, ?, ?, ?, ?)', randomUUID(), userId, id, sources[record.part].id, record.index, record.id, record.versionId)
        identities.set(`${record.part}:${record.index}`, record.id)
      })
      for (const binding of bindings) run('INSERT INTO message_assets VALUES (?, ?, ?, ?, ?, ?, ?)', randomUUID(), userId, id, identities.get(`${binding.part}:${binding.index}`), binding.slot, binding.kind, binding.assetId)
      return { id, userId, title, participants, revision: nextRevision, changed: true }
    })
  }
  const imports = createImportEngine({ db, directory, media, transaction, revision, advance, cancellation, progress: importProgress })
  const methods = {
    ...imports,
    status() { return { cleanupRequired: Boolean(get('SELECT cleanup_required FROM library_state').cleanup_required), version: 1, schemaVersion: SCHEMA_VERSION, revision: revision(), owner: get('SELECT user_id AS userId, label FROM owners') ?? null } },
    eraseLibrary() {
      media.close()
      transaction(() => {
        for (const table of ['analysis_turns','analysis_snapshots','discussions','reading_positions','preferences','conversation_pictures','source_assets',
          'occurrence_asset_versions','occurrence_assets','message_assets','source_occurrences','message_versions','messages','import_source_parts',
          'source_parts','imports','conversation_observations','review_decisions','import_history','conversations','assets','owner_identities','owner_mappings','owner_evidence','owners'])
          db.exec('DELETE FROM ' + table)
        run('UPDATE library_state SET cleanup_required=1,revision=revision+1')
      })
      return { cleanupRequired: true }
    },
    cleanLibraryFiles() {
      if (!get('SELECT cleanup_required FROM library_state').cleanup_required) fail()
      recoverFiles(directory, db)
      db.exec('VACUUM')
      syncDirectory(directory)
      return { cleaned: true }
    },
    finishLibraryDeletion() {
      run('UPDATE library_state SET cleanup_required=0')
      return { deleted: true, cleanupRequired: false }
    },
    resolveOwner({ expectedUserId, evidenceJson, label }) {
      if (!object(json(evidenceJson, 256 * 1024))) fail()
      text(label)
      const existing = get('SELECT user_id AS userId FROM owners')
      if (existing ? expectedUserId !== existing.userId : expectedUserId !== undefined) fail('library_owner_mismatch')
      return transaction(() => {
        const userId = existing?.userId ?? randomUUID(), evidenceId = randomUUID()
        if (!existing) run('INSERT INTO owners VALUES (?, 1, ?)', userId, label)
        else run('UPDATE owners SET label = ? WHERE user_id = ?', label, userId)
        run('INSERT INTO owner_evidence VALUES (?, ?, ?)', evidenceId, userId, evidenceJson)
        return { userId, evidenceId, revision: advance() }
      })
    },
    importConversation,
    conversations({ after = '', limit } = {}) {
      if (after !== '') uuid(after)
      return all('SELECT id, user_id AS userId, title, participants_json, category FROM conversations WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?', owner().userId, after, pageSize(limit)).map(publicConversation)
    },
    messages({ conversationId, after = -1, limit }) {
      const { userId } = conversation(conversationId)
      if (!Number.isSafeInteger(after) || after < -1) fail()
      return all(`SELECT m.id, m.user_id AS userId, m.conversation_id AS conversationId, m.ordinal, m.sender, m.text, m.timestamp,
        o.version_id AS versionId, o.part_id AS partId, o.source_index AS sourceIndex,
        (SELECT source_json FROM message_versions WHERE user_id=m.user_id AND id=o.version_id) AS sourceJson,
        (SELECT COUNT(*) FROM message_versions WHERE user_id=m.user_id AND message_id=m.id) AS versionCount,
        (SELECT COUNT(*) FROM (SELECT a.slot FROM occurrence_asset_versions a JOIN source_occurrences x ON x.user_id=a.user_id AND x.id=a.occurrence_id
          WHERE x.user_id=m.user_id AND x.message_id=m.id GROUP BY a.slot HAVING COUNT(DISTINCT a.asset_id)>1)) AS assetConflictCount
        FROM messages m JOIN source_occurrences o ON o.user_id = m.user_id AND o.message_id = m.id AND o.rowid = (SELECT MIN(x.rowid) FROM source_occurrences x WHERE x.user_id = m.user_id AND x.message_id = m.id)
        WHERE m.user_id = ? AND m.conversation_id = ? AND m.ordinal > ? ORDER BY m.ordinal LIMIT ?`, userId, conversationId, after, pageSize(limit))
        .map(message => ({ ...message, sourceAssets: all('SELECT uri,asset_id AS assetId FROM source_assets WHERE user_id=? AND part_id=? AND uri=?', userId, message.partId, thumbnailReference(JSON.parse(message.sourceJson)) ?? ''), attachments: all('SELECT id, user_id AS userId, asset_id AS assetId, slot, kind FROM message_assets WHERE user_id = ? AND message_id = ? ORDER BY slot', userId, message.id) }))
    },
    messageVersions({ messageId, after = 0, limit = 20 }) {
      const { userId } = owner()
      if (!Number.isSafeInteger(after) || after < 0) fail()
      if (!get('SELECT 1 FROM messages WHERE user_id=? AND id=?', userId, uuid(messageId))) fail('library_not_found')
      return all('SELECT id,user_id AS userId,rowid AS cursor,source_json AS sourceJson FROM message_versions WHERE user_id=? AND message_id=? AND rowid>? ORDER BY rowid LIMIT ?', userId, messageId, after, pageSize(limit)).map(version => ({ ...version,
        assets: all(`SELECT DISTINCT a.slot,a.asset_id AS assetId,ma.kind FROM occurrence_asset_versions a
          JOIN source_occurrences o ON o.user_id=a.user_id AND o.id=a.occurrence_id
          JOIN message_assets ma ON ma.user_id=o.user_id AND ma.message_id=o.message_id AND ma.slot=a.slot
          WHERE o.user_id=? AND o.version_id=? ORDER BY a.slot,a.asset_id`,userId,version.id) }))
    },
    snapshot({ conversationId, contexts }) {
      const { userId } = conversation(conversationId)
      const rows = all(`SELECT v.id,v.message_id AS messageId,length(CAST(v.source_json AS BLOB)) AS bytes FROM message_versions v
        JOIN messages m ON m.user_id=v.user_id AND m.id=v.message_id WHERE v.user_id=? AND v.conversation_id=? ORDER BY m.ordinal,v.rowid`, userId, conversationId)
      const references = {}, referenceMap = {}, indexes = new Map()
      rows.forEach((value,index) => { indexes.set(value.id,index); references[value.messageId] ??= index; referenceMap[`p1:m${index + 1}`] = value.messageId })
      const full = !contexts || contexts.some(value => value.scope === 'full')
      const wanted = new Set(contexts?.flatMap(value => value.references ?? []) ?? [])
      for (const reference of wanted) if (!Object.hasOwn(referenceMap, reference)) fail('library_context_changed')
      const selected = rows.filter((_value,index) => full || wanted.has(`p1:m${index + 1}`))
      let bytes = selected.reduce((sum,value) => sum + value.bytes, 0)
      if (bytes > 24_000_000) fail('library_context_too_large')
      const records = selected.map(value => {
        const source = get('SELECT source_json FROM message_versions WHERE user_id=? AND id=?', userId, value.id).source_json
        return full ? source : `${JSON.stringify(String(indexes.get(value.id)))}:${source}`
      })
      const provenance = []
      if (full) for (const part of db.prepare('SELECT id,import_id,source_json FROM source_parts WHERE user_id=? AND conversation_id=? ORDER BY rowid').iterate(userId,conversationId)) {
        const metadata = sourceMetadata(part.source_json)
        const occurrences = all('SELECT id,source_index AS sourceIndex,message_id AS messageId,version_id AS versionId FROM source_occurrences WHERE user_id=? AND part_id=? ORDER BY source_index', userId,part.id)
          .map(({ id, ...value }) => ({ ...value, recordIndex: indexes.get(value.versionId),
            assets: all(`SELECT a.slot,x.digest,x.size FROM occurrence_asset_versions a JOIN assets x ON x.user_id=a.user_id AND x.id=a.asset_id
              WHERE a.user_id=? AND a.occurrence_id=? ORDER BY a.slot,x.digest`,userId,id) }))
        const entry = `{"sourcePartId":${JSON.stringify(part.id)},"importId":${JSON.stringify(part.import_id)},"metadata":${metadata},"occurrences":${JSON.stringify(occurrences)}}`
        bytes += Buffer.byteLength(entry)
        if (bytes > 24_000_000) fail('library_context_too_large')
        provenance.push(entry)
      }
      const currentRevision = revision()
      const source = full ? `{"format":"echo-library-context-v1","revision":${currentRevision},"conversationId":${JSON.stringify(conversationId)},"provenance":[${provenance.join(',')}],"messages":[${records.join(',')}]}` : `{"messages":{${records.join(',')}}}`
      return { userId, conversationId, revision: currentRevision, sourceVersion: hash(JSON.stringify([userId,conversationId,currentRevision])), sourceParts: [source], references, referenceMap: full ? referenceMap : Object.fromEntries(selected.map(value => [`p1:m${indexes.get(value.id) + 1}`,value.messageId])) }
    },
    preferences() {
      const current = get('SELECT user_id AS userId FROM owners')
      return { userId: current?.userId ?? null, values: current ? Object.fromEntries(all('SELECT key,value_json FROM preferences WHERE user_id=?', current.userId).map(row => [row.key, JSON.parse(row.value_json)])) : {} }
    },
    savePreference({ key, value }) {
      const { userId } = owner()
      if (!['activeConversation', 'appearance', 'shelf'].includes(key) || typeof value !== 'string' || value.length > 128) fail()
      if (key === 'activeConversation' && value) conversation(value)
      run('INSERT INTO preferences VALUES (?, ?, ?) ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json', userId, key, JSON.stringify(value))
      return { userId, key, value }
    },
    correctIdentity({ label }) {
      text(label)
      const { userId } = owner()
      if (!get('SELECT 1 FROM messages WHERE user_id=? AND sender=?', userId, label)) fail()
      transaction(() => { run('UPDATE owners SET label=? WHERE user_id=?', label, userId); advance() })
      return { userId, label }
    },
    source({ partId }) {
      const value = get('SELECT id, user_id AS userId, conversation_id AS conversationId, source_json AS sourceJson FROM source_parts WHERE user_id = ? AND id = ?', owner().userId, uuid(partId))
      return value ?? fail('library_not_found')
    },
    savePosition({ conversationId, messageId, offset = 0 }) {
      const { userId } = conversation(conversationId)
      if (!Number.isInteger(offset) || Math.abs(offset) > 1_000_000) fail()
      if (!get('SELECT 1 FROM messages WHERE user_id = ? AND conversation_id = ? AND id = ?', userId, conversationId, uuid(messageId))) fail('library_not_found')
      run('INSERT INTO reading_positions VALUES (?, ?, ?, ?) ON CONFLICT(user_id, conversation_id) DO UPDATE SET message_id = excluded.message_id, offset = excluded.offset', userId, conversationId, messageId, offset)
      return { userId, conversationId, messageId, offset }
    },
    position({ conversationId }) {
      const { userId } = conversation(conversationId)
      return get('SELECT user_id AS userId, conversation_id AS conversationId, message_id AS messageId, offset FROM reading_positions WHERE user_id = ? AND conversation_id = ?', userId, conversationId) ?? null
    },
    beginAsset: () => media.begin(), appendAsset: input => media.append(input), finishAsset: input => media.finish(input),
    cancelAsset: input => media.cancel(input), asset: input => media.metadata(input), readAsset: input => media.read(input),
    close() { try { media.close() } finally { db.close() } },
  }
  Object.assign(methods, createDiscussions({ db, directory, owner, conversation, snapshot: methods.snapshot, transaction, revision }))
  return methods
}
