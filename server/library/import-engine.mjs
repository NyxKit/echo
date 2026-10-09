import { randomUUID } from 'node:crypto'
import { constants, openSync, closeSync, readSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { privateDirectory, privateFile, recoverFiles } from './files.mjs'
import { sourceMessageRecords } from '../../shared/analysis-source.mjs'
import { attachmentReferences, profileReferences, thumbnailReference, decode, digest, fileResolver, record } from '../imports/validate.mjs'
import { fingerprint, MATCHER_VERSION, orderedAnchors, reconcileRecords } from '../imports/matcher.mjs'
import { importLimits } from '../imports/limits.mjs'

const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const fail = code => { throw new Error(code) }
export function createImportEngine({ db, directory, media, transaction, revision, advance, cancellation, progress = () => {} }) {
  const get = (sql, ...values) => db.prepare(sql).get(...values)
  const all = (sql, ...values) => db.prepare(sql).all(...values)
  const run = (sql, ...values) => db.prepare(sql).run(...values)
  let deadline = Infinity, progressState, lastProgress = 0
  const check = () => {
    if (cancellation && Atomics.load(cancellation, 0)) fail('import_cancelled')
    if (Date.now() > deadline) fail('import_timeout')
  }
  function report(current, force = false) {
    check()
    if (!progressState) return
    if (force || Date.now() - lastProgress >= 150) {
      lastProgress = Date.now(); progress({ ...progressState, ...(current ? { current } : {}) })
    }
  }
  function groupProgress(jobId, phase, completed, total) {
    progressState = { jobId, phase, completed, total }; report(undefined, true)
  }
  function bounded(action) {
    deadline = Date.now() + importLimits.duration
    try { return action() } finally { deadline = Infinity; progressState = undefined }
  }
  function load(jobId) {
    if (!id(jobId)) fail('library_invalid_input')
    const root = join(directory, 'imports', jobId)
    privateDirectory(root)
    const path = join(root, 'plan.json')
    if (privateFile(path).size > 64 * 1024 * 1024) fail('import_limit')
    const plan = JSON.parse(readFileSync(path, 'utf8'))
    if (plan.version !== 1 || !Array.isArray(plan.files) || !Array.isArray(plan.conversations)) fail('import_invalid')
    return { plan, root }
  }
  function sources(root, group) {
    let bytes = 0, count = 0
    const records = []
    const parts = group.parts.map((part, ordinal) => {
      check()
      if (!id(part.id)) fail('import_invalid')
      const path = join(root, part.id)
      const size = privateFile(path).size
      bytes += size
      if (size > 8 * 1024 * 1024 || bytes > 32 * 1024 * 1024) fail('import_limit')
      const source = readFileSync(path, 'utf8'), parsed = JSON.parse(source)
      if (digest(source) !== part.digest || !Array.isArray(parsed.messages)) fail('import_integrity')
      const raw = sourceMessageRecords(source)
      raw.forEach((text, index) => {
        if (++count > 100_000) fail('import_limit')
        if (index % 256 === 0) report({ unit: 'messages', completed: count - 1, total: group.messages })
        const value = parsed.messages[index]
        if (!record(value)) fail('import_invalid')
        records.push({ part: ordinal, index, source: text, fingerprint: fingerprint(text), value,
          sender: decode(value.sender_name) || 'Unknown sender', text: decode(value.content),
          timestamp: Number.isSafeInteger(value.timestamp_ms) && Math.abs(value.timestamp_ms) <= 8.64e15 ? value.timestamp_ms : null })
      })
      return { ...part, source, pictures: profileReferences(parsed) }
    })
    if (new Set(parts.map(part => part.digest)).size !== parts.length) fail('import_invalid')
    records.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.part - b.part || a.index - b.index)
    return { records, parts }
  }
  function previous(userId, conversationId) {
    const size = get('SELECT COALESCE(SUM(length(CAST(source_json AS BLOB))),0) AS size FROM message_versions WHERE user_id=? AND conversation_id=?', userId, conversationId).size
    if (size > 96 * 1024 * 1024) fail('import_limit')
    const rows = all(`SELECT m.id, m.sender, m.timestamp, v.source_json AS source FROM messages m
      JOIN message_versions v ON v.user_id=m.user_id AND v.message_id=m.id
      AND v.rowid=(SELECT MIN(x.rowid) FROM message_versions x WHERE x.user_id=m.user_id AND x.message_id=m.id)
      WHERE m.user_id=? AND m.conversation_id=? ORDER BY m.ordinal LIMIT 100001`, userId, conversationId)
    if (rows.length > 100_000) fail('import_limit')
    return rows.map((row, index) => { if (index % 256 === 0) check(); return { ...row, fingerprint: fingerprint(row.source) } })
  }
  function inferOwner(groups) {
    const sets = groups.filter(group => group.length)
    if (new Set(sets.map(group => JSON.stringify([...new Set(group)].sort()))).size < 2) return undefined
    const common = sets[0].filter(name => name !== 'Unknown sender' && sets.every(group => group.includes(name)))
    return common.length === 1 ? common[0] : undefined
  }
  function resolveOwner(plan, choice, linked = false) {
    const existing = get('SELECT user_id AS userId, label FROM owners')
    const explicit = plan.owner.explicit, ids = [...new Set(explicit.map(value => value.stableId).filter(Boolean))]
    if (ids.length > 1) fail('import_owner_mismatch')
    const knownIds = existing ? all('SELECT stable_id FROM owner_identities WHERE user_id=?', existing.userId).map(value => value.stable_id) : []
    if (ids.length && knownIds.length && !knownIds.includes(ids[0])) fail('import_owner_mismatch')
    const fallbackHash = digest(JSON.stringify(plan.conversations.flatMap(group => group.parts.map(part => part.digest)).sort()))
    const fallback = existing && get('SELECT label FROM owner_mappings WHERE user_id=? AND evidence_hash=?', existing.userId, fallbackHash)
    const labels = [...new Set(explicit.map(value => value.label))]
    const incoming = plan.conversations.map(group => group.participants)
    const inferred = inferOwner(incoming)
    const stored = existing && !explicit.length && !fallback ? all('SELECT participants_json FROM conversations WHERE user_id=? LIMIT 10001', existing.userId) : []
    if (stored.length > 10_000) fail('import_limit')
    const combined = existing && incoming.some(group => group.includes(existing.label))
      ? inferOwner([...incoming, ...stored.map(row => JSON.parse(row.participants_json))]) : undefined
    const inherited = existing && !explicit.length && (combined === existing.label || linked && plan.owner.candidates.includes(existing.label))
    const label = choice?.label ?? (labels.length === 1 ? labels[0] : labels.length ? undefined : fallback?.label ?? (inherited ? existing.label : inferred))
    if (choice && (!plan.owner.candidates.includes(label) || existing && choice.sameOwner !== true)) fail('import_owner_review')
    const known = existing && (inherited || fallback || ids.some(value => knownIds.includes(value)) || explicit.some(value =>
      get('SELECT 1 FROM owner_mappings WHERE user_id=? AND evidence_hash=?', existing.userId, value.evidenceHash)))
    const needsReview = !label || !!existing && !known && !choice
    const evidence = { label, method: choice ? 'review' : fallback ? 'saved' : explicit.length ? 'explicit'
      : inherited ? (combined === existing.label ? 'combined_participants' : 'matched_history') : 'common_participants' }
    return { existing, label, fallbackHash, stableId: ids[0], needsReview, candidates: plan.owner.candidates, evidence }
  }
  function observationKey(group) {
    const parts = group.directory.split('/'), section = parts.indexOf('messages')
    const grouping = section >= 0 ? parts.slice(section).join('/') : parts.slice(-1).join('/')
    return digest(JSON.stringify([grouping, group.parts.map(part => part.digest).sort()]))
  }
  function matchGroup(root, group, userId, choices = {}, messageChoices = {}, self) {
    const current = sources(root, group), key = observationKey(group)
    const known = userId && get('SELECT conversation_id FROM conversation_observations WHERE user_id=? AND observation_key=?', userId, key)
    const decisions = userId && get('SELECT decision_json FROM review_decisions WHERE user_id=? AND observation_key=?', userId, key)
    const chosen = known?.conversation_id ?? choices[group.key]
    const candidates = []
    const participantKey = JSON.stringify([...group.participants].sort())
    let cachedPrevious, cachedId
    const possibleConversations = !userId || chosen === 'separate' ? [] : chosen ? all('SELECT id,title,participants_json FROM conversations WHERE user_id=? AND id=?',userId,chosen) : all('SELECT id, title, participants_json FROM conversations WHERE user_id=? LIMIT 10001', userId)
    if (possibleConversations.length > 10_000) fail('import_limit')
    let checkedCandidates = 0
    for (const row of possibleConversations) {
      report({ unit: 'candidates', completed: checkedCandidates++, total: possibleConversations.length })
      check()
      const participants = JSON.parse(row.participants_json)
      if (row.id !== chosen && row.title !== group.title && !participants.some(name => name !== self && group.participants.includes(name))) continue
      let confident = false
      // Different participant sets cannot be automatic matches. Retain them
      // for review without reading/hashing their entire message histories.
      // Explicit and previously saved choices do not need anchor discovery.
      if (!chosen && JSON.stringify([...participants].sort()) === participantKey) {
        cachedPrevious = previous(userId, row.id); cachedId = row.id
        const evidence = orderedAnchors(cachedPrevious, current.records)
        confident = evidence.confident || row.title === group.title && (evidence.anchors.length > 0 || evidence.identical)
      }
      candidates.push({ id: row.id, title: row.title, confident })
    }
    const confident = candidates.filter(value => value.confident)
    let target = chosen ?? (confident.length === 1 ? confident[0].id : candidates.length ? undefined : 'separate')
    if (target && target !== 'separate' && !candidates.some(value => value.id === target)) fail('library_invalid_input')
    const old = target && target !== 'separate' && !known ? (cachedId === target ? cachedPrevious : previous(userId, target)) : []
    const result = old.length && !known ? reconcileRecords(old, current.records) : { matches: new Map(), ambiguous: [] }
    const saved = decisions ? JSON.parse(decisions.decision_json) : {}
    const supplied = messageChoices[group.key] ?? saved.messages ?? {}
    if (known) {
      const knownParts = current.parts.map(part => get('SELECT id FROM source_parts WHERE user_id=? AND conversation_id=? AND digest=?', userId, target, part.digest)?.id)
      current.records.forEach((entry, index) => {
        if (index % 256 === 0) report({ unit: 'messages', completed: index, total: current.records.length })
        const occurrence = get('SELECT message_id FROM source_occurrences WHERE user_id=? AND part_id=? AND source_index=?', userId, knownParts[entry.part], entry.index)
        if (occurrence) result.matches.set(index, occurrence.message_id)
      })
    }
    const used = new Set(result.matches.values())
    const unresolved = [], oldIndexes = new Map(old.map((entry, index) => [entry.id, index]))
    for (const item of result.ambiguous) {
      if (result.matches.has(item.index)) continue
      const answer = supplied[item.index]
      if (answer === 'separate') continue
      if (answer && item.candidates.includes(answer) && !used.has(answer)) { result.matches.set(item.index, answer); used.add(answer) }
      else unresolved.push({ ...item, evidence: item.candidates.map(candidate => {
        const position = oldIndexes.get(candidate), row = old[position]
        return { id: candidate, sender: row.sender, timestamp: row.timestamp, text: decode(JSON.parse(row.source).content),
          before: position > 0 ? decode(JSON.parse(old[position - 1].source).content) : '', after: position + 1 < old.length ? decode(JSON.parse(old[position + 1].source).content) : '' }
      }), sender: current.records[item.index].sender, text: current.records[item.index].text, timestamp: current.records[item.index].timestamp })
    }
    return { ...current, key, target, matches: result.matches, unresolved, candidates, supplied }
  }
  function inspect({ jobId, ownerChoice, conversations = {}, messages = {} }) {
    check()
    const { plan, root } = load(jobId)
    let owner = resolveOwner(plan, ownerChoice), linked = false
    const groups = []; let reviewBytes = 0
    for (const group of plan.conversations) {
      groupProgress(jobId, 'matching', groups.length, plan.conversations.length)
      const matched = matchGroup(root, group, owner.existing?.userId, conversations, messages, owner.label ?? owner.existing?.label)
      if (!conversations[group.key] && matched.target && matched.matches.size && group.participants.includes(owner.existing?.label)) linked = true
      const result = { key: group.key, title: group.title, target: matched.target ?? null, candidates: matched.candidates, messages: matched.unresolved, count: matched.records.length }
      reviewBytes += Buffer.byteLength(JSON.stringify(result))
      if (reviewBytes > 8 * 1024 * 1024) fail('import_limit')
      groups.push(result)
    }
    groupProgress(jobId, 'matching', groups.length, plan.conversations.length)
    if (linked && owner.needsReview) owner = resolveOwner(plan, ownerChoice, true)
    return { resolved: owner, review: { version: 1, owner: { label: owner.label ?? '', needsReview: owner.needsReview, candidates: owner.candidates, existing: owner.existing ?? null },
      conversations: groups, ready: !owner.needsReview && groups.every(group => group.target && !group.messages.length) } }
  }
  function preview(input) { return inspect(input).review }
  function copyAsset(root, file, copied) {
    if (!file) return null
    if (copied.has(file.id)) return copied.get(file.id)
    check()
    const path = join(root, file.id)
    if (privateFile(path).size !== file.size) fail('import_integrity')
    const upload = media.begin(), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const buffer = Buffer.alloc(1024 * 1024)
      let length
      while ((length = readSync(fd, buffer)) > 0) { check(); media.append({ id: upload.id, bytes: buffer.subarray(0, length) }) }
      const asset = media.finish({ id: upload.id }); copied.set(file.id, asset.id); return asset.id
    } catch (error) { try { media.cancel({ id: upload.id }) } catch { /* Recovery retains failed staging. */ } throw error }
    finally { closeSync(fd) }
  }
  function commit(input) {
    const already = get('SELECT user_id AS userId, revision, summary_json FROM import_history WHERE id=?', input.jobId)
    if (already) return { userId: already.userId, revision: already.revision, ...JSON.parse(already.summary_json) }
    const { review: reviewed, resolved } = inspect(input)
    if (!reviewed.ready) fail(reviewed.owner.needsReview ? 'import_owner_review' : 'library_reconciliation_required')
    const selections = Object.fromEntries(reviewed.conversations.map(group => [group.key, group.target]))
    const { plan, root } = load(input.jobId)
    if (resolved.needsReview) fail('import_owner_review')
    const resolveFile = fileResolver(plan.files), copied = new Map()
    try {
      return transaction(() => {
        const userId = resolved.existing?.userId ?? randomUUID()
        if (!resolved.existing) run('INSERT INTO owners VALUES (?, 1, ?)', userId, resolved.label)
        else run('UPDATE owners SET label=? WHERE user_id=?', resolved.label, userId)
        if (resolved.stableId) run('INSERT OR IGNORE INTO owner_identities VALUES (?, ?)', userId, resolved.stableId)
        for (const item of plan.owner.explicit) run('INSERT OR IGNORE INTO owner_mappings VALUES (?, ?, ?, ?)', userId, item.evidenceHash, resolved.label, JSON.stringify(item.evidence))
        run('INSERT INTO owner_mappings VALUES (?, ?, ?, ?) ON CONFLICT(user_id, evidence_hash) DO UPDATE SET label=excluded.label, source_json=excluded.source_json', userId, resolved.fallbackHash, resolved.label, JSON.stringify(resolved.evidence))
        const evidenceId = randomUUID()
        run('INSERT INTO owner_evidence VALUES (?, ?, ?)', evidenceId, userId, JSON.stringify({ owner: plan.owner, choice: input.ownerChoice ?? null, resolution: resolved.evidence }))
        const summary = { additions: 0, matched: 0, changed: 0, unavailableAssets: 0, conversations: 0, unresolved: 0 }
        let changed = !resolved.existing
        let completedGroups = 0
        for (const group of plan.conversations) {
          groupProgress(input.jobId, 'committing', completedGroups, plan.conversations.length)
          check()
          // Evaluate against the original owner scope, including earlier accepted groups.
          const matched = matchGroup(root, group, userId, selections, input.messages)
          if (!matched.target || matched.unresolved.length) fail('library_reconciliation_required')
          const conversationId = matched.target === 'separate' ? randomUUID() : matched.target
          if (matched.target === 'separate') {
            run('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)', conversationId, userId, group.title, JSON.stringify(group.participants), matched.key, group.category)
            summary.conversations++; changed = true
          }
          if (matched.target !== 'separate') {
            const stored = JSON.parse(get('SELECT participants_json FROM conversations WHERE user_id=? AND id=?',userId,conversationId).participants_json)
            const participants = [...new Set([...stored,...group.participants])]
            if (participants.length > 1000 || Buffer.byteLength(JSON.stringify(participants)) > 32768) fail('import_limit')
            if (participants.length !== stored.length) { run('UPDATE conversations SET participants_json=? WHERE user_id=? AND id=?',JSON.stringify(participants),userId,conversationId); changed = true }
          }
          const importId = randomUUID(), nextRevision = revision() + 1
          run('INSERT INTO imports VALUES (?, ?, ?, ?, ?)', importId, userId, conversationId, evidenceId, nextRevision)
          const partIds = new Map(), existingParts = new Set()
          matched.parts.forEach((part, ordinal) => {
            const existing = get('SELECT id FROM source_parts WHERE user_id=? AND conversation_id=? AND digest=?', userId, conversationId, part.digest)
            const partId = existing?.id ?? randomUUID(); partIds.set(ordinal, partId)
            if (existing) existingParts.add(ordinal)
            else { run('INSERT INTO source_parts VALUES (?, ?, ?, ?, ?, ?, ?)', partId, userId, conversationId, importId, part.digest, part.source, ordinal); changed = true }
            run('INSERT INTO import_source_parts VALUES (?,?,?,?)', userId, importId, partId, ordinal)
          })
          matched.parts.forEach((part, index) => {
            for (const picture of part.pictures) {
              if (/^https?:/i.test(picture.uri)) continue
              const assetId = copyAsset(root, resolveFile(picture.uri, group.directory), copied)
              if (!assetId) continue
              run('INSERT OR IGNORE INTO source_assets VALUES (?, ?, ?, ?)', userId, partIds.get(index), picture.uri, assetId)
              const result = run('INSERT OR IGNORE INTO conversation_pictures VALUES (?, ?, ?, ?)', userId, conversationId, picture.name, assetId)
              if (result.changes) changed = true
            }
          })
          let ordinal = get('SELECT COALESCE(MAX(ordinal), -1) AS value FROM messages WHERE user_id=? AND conversation_id=?', userId, conversationId).value + 1
          matched.records.forEach((entry, index) => {
            check()
            if (index % 256 === 0) report({ unit: 'messages', completed: index, total: matched.records.length })
            const partId = partIds.get(entry.part)
            let occurrence = existingParts.has(entry.part) ? get('SELECT id, message_id, version_id FROM source_occurrences WHERE user_id=? AND part_id=? AND source_index=?', userId, partId, entry.index) : undefined
            let messageId = occurrence?.message_id ?? matched.matches.get(index)
            if (!messageId) {
              messageId = randomUUID(); summary.additions++; changed = true
              run('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)', messageId, userId, conversationId, ordinal++, entry.sender, entry.text, entry.timestamp)
            } else summary.matched++
            let versionId = occurrence?.version_id ?? get('SELECT id FROM message_versions WHERE user_id=? AND message_id=? AND source_json=?', userId, messageId, entry.source)?.id
            if (!versionId) {
              const hasVersion = get('SELECT 1 FROM message_versions WHERE user_id=? AND message_id=?', userId, messageId)
              if (hasVersion) summary.changed++
              versionId = randomUUID(); changed = true
              run('INSERT INTO message_versions VALUES (?, ?, ?, ?, ?)', versionId, userId, conversationId, messageId, entry.source)
            }
            if (!occurrence) {
              occurrence = { id: randomUUID() }
              run('INSERT INTO source_occurrences VALUES (?, ?, ?, ?, ?, ?, ?)', occurrence.id, userId, conversationId, partId, entry.index, messageId, versionId)
            }
            const thumbnail = thumbnailReference(entry.value)
            if (thumbnail && !/^https?:/i.test(thumbnail)) {
              const assetId = copyAsset(root, resolveFile(thumbnail, group.directory), copied)
              if (assetId) {
                const result = run('INSERT OR IGNORE INTO source_assets VALUES (?, ?, ?, ?)', userId, partId, thumbnail, assetId)
                if (result.changes) changed = true
              }
            }
            attachmentReferences(entry.value).forEach((attachment, slot) => {
              if (/^https?:/i.test(attachment.uri)) return
              const assetId = copyAsset(root, resolveFile(attachment.uri, group.directory), copied)
              if (!assetId) summary.unavailableAssets++
              const old = get('SELECT id, asset_id FROM message_assets WHERE user_id=? AND message_id=? AND slot=?', userId, messageId, slot)
              if (!old) run('INSERT INTO message_assets VALUES (?, ?, ?, ?, ?, ?, ?)', randomUUID(), userId, conversationId, messageId, slot, attachment.kind, assetId)
              else if (!old.asset_id && assetId) { run('UPDATE message_assets SET asset_id=? WHERE id=? AND user_id=?', assetId, old.id, userId); changed = true }
              const prior = get('SELECT asset_id FROM occurrence_assets WHERE user_id=? AND occurrence_id=? AND slot=?', userId, occurrence.id, slot)
              if (!prior) run('INSERT INTO occurrence_assets VALUES (?, ?, ?, ?, ?)', userId, occurrence.id, slot, attachment.uri, assetId)
              else if (!prior.asset_id && assetId) { run('UPDATE occurrence_assets SET asset_id=? WHERE user_id=? AND occurrence_id=? AND slot=?', assetId, userId, occurrence.id, slot); changed = true }
              if (assetId) {
                const inserted = run('INSERT OR IGNORE INTO occurrence_asset_versions VALUES (?, ?, ?, ?)', userId, occurrence.id, slot, assetId)
                if (prior?.asset_id && prior.asset_id !== assetId && inserted.changes) { summary.changed++; changed = true }
              }
            })
          })
          // Positive displacement avoids the unique ordinal constraint while
          // preserving every stable message ID and its reading/discussion refs.
          const ordered = all('SELECT id FROM messages WHERE user_id=? AND conversation_id=? ORDER BY COALESCE(timestamp,0), ordinal', userId, conversationId)
          run('UPDATE messages SET ordinal=ordinal+? WHERE user_id=? AND conversation_id=?', ordinal + ordered.length + 1, userId, conversationId)
          ordered.forEach((entry, index) => run('UPDATE messages SET ordinal=? WHERE user_id=? AND id=?', index, userId, entry.id))
          run('INSERT OR IGNORE INTO conversation_observations VALUES (?, ?, ?, ?)', userId, matched.key, conversationId, MATCHER_VERSION)
          run('INSERT OR IGNORE INTO review_decisions VALUES (?, ?, ?, ?)', randomUUID(), userId, matched.key, JSON.stringify({ conversationId, messages: matched.supplied }))
          groupProgress(input.jobId, 'committing', ++completedGroups, plan.conversations.length)
        }
        check()
        const nextRevision = changed ? advance() : revision()
        run('INSERT INTO import_history VALUES (?, ?, ?, ?)', input.jobId, userId, nextRevision, JSON.stringify(summary))
        return { userId, revision: nextRevision, ...summary }
      })
    } catch (error) {
      // The rollback has removed references to any newly installed bytes.
      // Recovery only removes files proven unreferenced by committed rows.
      try { recoverFiles(directory, db) } catch { fail('import_cleanup') }
      throw error
    }
  }
  return { previewImport: input => bounded(() => preview(input)), commitImport: input => bounded(() => commit(input)),
    importHistory() { const owner = get('SELECT user_id FROM owners'); return owner ? all('SELECT id, user_id AS userId, revision, summary_json FROM import_history WHERE user_id=? ORDER BY rowid DESC LIMIT 100', owner.user_id).map(row => ({ id: row.id, userId: row.userId, revision: row.revision, ...JSON.parse(row.summary_json) })) : [] } }
}
