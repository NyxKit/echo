import { createPortability } from './portability.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { attachmentReferences } from '../imports/validate.mjs'
import { isTimeScope, timeWindowIndexes } from '../../shared/context-windows.mjs'
import { validateAnalysis, contextScopes } from '../../shared/analysis-policy.mjs'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const fail = code => { throw new Error(code) }
const json = value => JSON.stringify(value)
export function createDiscussions({ db, directory, owner, conversation, snapshot, transaction, revision }) {
  const get = (sql, ...values) => db.prepare(sql).get(...values)
  const all = (sql, ...values) => db.prepare(sql).all(...values)
  const run = (sql, ...values) => db.prepare(sql).run(...values)
  // No accepted inference is automatically redispatched after restart.
  run("UPDATE analysis_turns SET status='interrupted',error='outcome_unknown' WHERE status='sending'")
  function discussion(id) {
    if (!uuid(id)) fail('library_invalid_input')
    return get('SELECT id,user_id AS userId,conversation_id AS conversationId,title,draft,scope,draft_revision AS draftRevision,source_version AS sourceVersion FROM discussions WHERE user_id=? AND id=?', owner().userId, id) ?? fail('library_not_found')
  }
  function turn(id) {
    if (!uuid(id)) fail('library_invalid_input')
    return get(`SELECT t.id,t.user_id AS userId,t.discussion_id AS discussionId,t.sequence,t.status,t.answer,t.error,s.payload_json,s.reference_map_json,s.source_evidence_json,s.library_revision AS libraryRevision,s.provider_account AS providerAccount
      FROM analysis_turns t JOIN analysis_snapshots s ON s.user_id=t.user_id AND s.id=t.snapshot_id WHERE t.user_id=? AND t.id=?`, owner().userId, id) ?? fail('library_not_found')
  }
  function turns(discussionId) {
    const item = discussion(discussionId)
    return all(`SELECT t.id,t.user_id AS userId,t.sequence,t.status,t.answer,t.error,s.payload_json,s.reference_map_json,s.source_evidence_json
      FROM analysis_turns t JOIN analysis_snapshots s ON s.user_id=t.user_id AND s.id=t.snapshot_id WHERE t.user_id=? AND t.discussion_id=? ORDER BY t.sequence`, item.userId, item.id)
  }
  function publicTurn(row) { const payload = JSON.parse(row.payload_json); return { ...payload.turn, id: row.id, userId: row.userId, sequence: row.sequence, referenceMap: JSON.parse(row.reference_map_json), answer: row.answer, status: row.status, error: row.error } }
  const methods = {
    discussions({ conversationId }) {
      const { userId } = conversation(conversationId)
      return all('SELECT id,user_id AS userId,conversation_id AS conversationId,title,draft,scope,draft_revision AS draftRevision,source_version AS sourceVersion FROM discussions WHERE user_id=? AND conversation_id=? ORDER BY rowid LIMIT 500', userId, conversationId)
    },
    discussion({ discussionId }) {
      const item = discussion(discussionId), rows = turns(discussionId), latest = rows.findLast(value => value.status === 'complete')
      const payload = latest && JSON.parse(latest.payload_json)
      return { ...item, turns: rows.map(publicTurn), contextSource: payload ? { sourceVersion: payload.sourceVersion, sourceParts: payload.sourceParts } : undefined }
    },
    saveDiscussion({ id, conversationId, title, draft, scope, draftRevision = 0 }) {
      const { userId } = conversation(conversationId)
      if (!uuid(id) || typeof title !== 'string' || title.length > 160 || typeof draft !== 'string' || draft.length > 16_000 ||
          !contextScopes.includes(scope) || !Number.isSafeInteger(draftRevision) || draftRevision < 0) fail('library_invalid_input')
      return transaction(() => {
        const existing = get('SELECT user_id,conversation_id,draft_revision FROM discussions WHERE id=?', id)
        if (existing && (existing.user_id !== userId || existing.conversation_id !== conversationId)) fail('library_not_found')
        if (existing ? draftRevision !== existing.draft_revision : draftRevision !== 0) fail('library_draft_conflict')
        if (!existing && get('SELECT COUNT(*) AS count FROM discussions WHERE user_id=? AND conversation_id=?', userId, conversationId).count >= 500) fail('library_limit')
        if (existing) run('UPDATE discussions SET title=?,draft=?,scope=?,draft_revision=draft_revision+1 WHERE user_id=? AND id=?', title, draft, scope, userId, id)
        else run('INSERT INTO discussions (id,user_id,conversation_id,title,draft,scope) VALUES (?,?,?,?,?,?)', id, userId, conversationId, title, draft, scope)
        return discussion(id)
      })
    },
    deleteDiscussion({ discussionId }) {
      const item = discussion(discussionId)
      if (get("SELECT 1 FROM analysis_turns WHERE user_id=? AND discussion_id=? AND status='sending'", item.userId, item.id)) fail('library_busy')
      transaction(() => {
        run('DELETE FROM analysis_turns WHERE user_id=? AND discussion_id=?', item.userId, item.id)
        run('DELETE FROM analysis_snapshots WHERE user_id=? AND discussion_id=?', item.userId, item.id)
        run('DELETE FROM discussions WHERE user_id=? AND id=?', item.userId, item.id)
      })
      return { deleted: true }
    },
    analysisTurn({ turnId }) {
      const row = turn(turnId)
      return { ...publicTurn(row), discussionId: row.discussionId, requestDigest: createHash('sha256').update(row.payload_json).digest('hex'), libraryRevision: row.libraryRevision }
    },
    contextInput({ discussionId, question, focus = [], scope, model }) {
      const item = discussion(discussionId)
      if (typeof question !== 'string' || !question.trim() || question.length > 16000 || !Array.isArray(focus) || focus.length > 500 || new Set(focus).size !== focus.length ||
          !focus.every(uuid) || !contextScopes.includes(scope) || typeof model !== 'string' || model.length > 160) fail('library_invalid_input')
      const prior = turns(item.id).filter(row => row.status === 'complete')
      const history = prior.map(row => ({ ...JSON.parse(row.payload_json).turn, answer: row.answer }))
      const turnInput = { question: question.trim(), focus: [], context: { scope }, images: [], excluded: [] }
      if (!focus.length && prior.length) {
        const previous = JSON.parse(prior.at(-1).payload_json)
        turnInput.context = { scope: 'discussion' }
        return { userId: item.userId, conversationId: item.conversationId, revision: revision(), sourceVersion: previous.sourceVersion,
          sourceParts: previous.sourceParts, history, turn: turnInput, attachments: [], model, referenceMap: JSON.parse(prior.at(-1).reference_map_json) }
      }
      const messages = all('SELECT id,ordinal,timestamp FROM messages WHERE user_id=? AND conversation_id=? ORDER BY ordinal', item.userId,item.conversationId)
      const wanted = new Set(focus), positions = new Set(), chosen = messages.filter(value => wanted.has(value.id))
      if (chosen.length !== focus.length || !messages.length || scope === 'selected' && !focus.length) fail('library_invalid_input')
      if (!focus.length && scope === 'surrounding') for (let index=Math.max(0,messages.length-20);index<messages.length;index++) positions.add(index)
      if (isTimeScope(scope)) {
        try { for (const index of timeWindowIndexes(messages, messages.flatMap((value, index) => wanted.has(value.id) ? [index] : []), scope)) positions.add(index) }
        catch { fail('library_context_timestamps_unavailable') }
      } else if (scope !== 'full') messages.forEach((value,index) => { if (wanted.has(value.id)) for (let cursor=scope==='surrounding'?Math.max(0,index-20):index;cursor<= (scope==='surrounding'?Math.min(messages.length-1,index+20):index);cursor++) positions.add(cursor) })
      const selectedVersions = all(`SELECT v.id,v.message_id AS messageId FROM message_versions v JOIN messages m ON m.user_id=v.user_id AND m.id=v.message_id
        WHERE v.user_id=? AND v.conversation_id=? ORDER BY m.ordinal,v.rowid`,item.userId,item.conversationId)
      const references = new Map()
      selectedVersions.forEach((value,index) => { if (!references.has(value.messageId)) references.set(value.messageId,`p1:m${index+1}`) })
      turnInput.focus = chosen.map(value => references.get(value.id))
      if (scope !== 'full') turnInput.context.references = [...positions].sort((a,b)=>a-b).map(index=>references.get(messages[index].id))
      const current = snapshot({ conversationId: item.conversationId, contexts: [...history.map(value=>value.context),turnInput.context] })
      if (item.sourceVersion && item.sourceVersion !== current.sourceVersion) fail('library_context_changed')
      const attachments = chosen.flatMap(value => {
        const variants = get(`SELECT COUNT(*) AS count FROM (SELECT a.slot FROM occurrence_asset_versions a JOIN source_occurrences o ON o.user_id=a.user_id AND o.id=a.occurrence_id
          WHERE o.user_id=? AND o.message_id=? GROUP BY a.slot HAVING COUNT(DISTINCT a.asset_id)>1)`,item.userId,value.id).count
        if (variants) turnInput.excluded.push({ reference: references.get(value.id), reason: 'Conflicting attachment observations are retained. Only the first stored attachment bytes are prepared for this selection.' })
        const raw = JSON.parse(get('SELECT source_json FROM message_versions WHERE user_id=? AND message_id=? ORDER BY rowid LIMIT 1',item.userId,value.id).source_json)
        const assets = all('SELECT asset_id AS assetId,slot,kind FROM message_assets WHERE user_id=? AND message_id=? ORDER BY slot',item.userId,value.id)
        return attachmentReferences(raw).map((asset,slot)=>({ kind: asset.kind, assetId: assets.find(value=>value.slot===slot)?.assetId ?? null,
          remote: /^https?:/i.test(asset.uri), animated: /\.gif(?:$|[?#])/i.test(asset.uri), reference: references.get(value.id) }))
      })
      return { ...current, history, turn: turnInput, attachments, model }
    },
    acceptTurn({ discussionId, payload, providerAccount }) {
      const item = discussion(discussionId)
      if (typeof providerAccount !== 'string' || !/^[a-f0-9]{64}$/.test(providerAccount)) fail('library_invalid_input')
      let validated
      try { validated = validateAnalysis(payload) } catch { fail('library_invalid_input') }
      const encoded = json(validated)
      const duplicate = get('SELECT id FROM analysis_turns WHERE id=?', validated.requestId)
      if (duplicate) {
        const previous = turn(duplicate.id)
        if (previous.discussionId !== discussionId || previous.payload_json !== encoded || previous.providerAccount !== providerAccount) fail('library_invalid_input')
        return { accepted: false, ...methods.analysisTurn({ turnId: duplicate.id }) }
      }
      if (get("SELECT 1 FROM analysis_turns WHERE user_id=? AND discussion_id=? AND status='sending'", item.userId, item.id)) fail('library_busy')
      const prior = turns(item.id)
      if (prior.length >= 100) fail('library_limit')
      const completed = prior.filter(row => row.status === 'complete')
      const history = completed.map(row => ({ ...JSON.parse(row.payload_json).turn, answer: row.answer }))
      if (json(history) !== json(validated.history) || hash(validated.sourceParts) !== validated.contextVersion) fail('library_context_changed')
      const old = completed.at(-1), previous = old && JSON.parse(old.payload_json)
      let libraryRevision = revision(), referenceMap = {}, sourceEvidence = null
      if (validated.turn.context.scope === 'discussion' && previous) {
        referenceMap = JSON.parse(old.reference_map_json); sourceEvidence = old.source_evidence_json
        if (validated.sourceVersion !== previous.sourceVersion || json(validated.sourceParts) !== json(previous.sourceParts)) fail('library_context_changed')
      } else {
        const current = snapshot({ conversationId: item.conversationId, contexts: [...history.map(value => value.context), validated.turn.context] })
        if (current.sourceVersion !== validated.sourceVersion || item.sourceVersion && item.sourceVersion !== validated.sourceVersion) fail('library_context_changed')
        const expected = current.sourceParts
        if (json(expected) !== json(validated.sourceParts)) fail('library_context_changed')
        libraryRevision = current.revision; referenceMap = current.referenceMap
      }
      const space = statfsSync(directory, { bigint: true })
      if (space.bavail * space.bsize < BigInt(Buffer.byteLength(encoded) * 3 + 256 * 1024 * 1024)) fail('library_disk_full')
      return transaction(() => {
        const snapshotId = randomUUID(), id = validated.requestId
        run('INSERT INTO analysis_snapshots (id,user_id,conversation_id,discussion_id,library_revision,provider_account,model,payload_json,reference_map_json,source_evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?)', snapshotId, item.userId, item.conversationId, item.id, libraryRevision, providerAccount, validated.model, encoded, json(referenceMap), sourceEvidence)
        run("INSERT INTO analysis_turns (id,user_id,discussion_id,snapshot_id,sequence,status) VALUES (?,?,?,?,?,'sending')", id, item.userId, item.id, snapshotId, prior.length)
        run('UPDATE discussions SET source_version=?,title=CASE WHEN title=? THEN ? ELSE title END WHERE user_id=? AND id=?', validated.sourceVersion, 'New discussion', validated.turn.question.slice(0,60), item.userId, item.id)
        return { accepted: true, ...methods.analysisTurn({ turnId: id }) }
      })
    },
    updateTurn({ turnId, answer, status = 'sending', error = null }) {
      const row = turn(turnId)
      if (row.status !== 'sending') fail('library_invalid_input')
      if (typeof answer !== 'string' || answer.length > 500_000 || !['sending','complete','failed','canceled','interrupted'].includes(status) ||
          error !== null && !['outcome_unknown','canceled','provider_failed','storage_failed','expired','quota','provider_context'].includes(error)) fail('library_invalid_input')
      run('UPDATE analysis_turns SET answer=?,status=?,error=? WHERE user_id=? AND id=?', answer, status, error, row.userId, row.id)
      if (status === 'complete') run("UPDATE discussions SET draft='',draft_revision=draft_revision+1 WHERE user_id=? AND id=? AND trim(draft)=?", row.userId, row.discussionId, JSON.parse(row.payload_json).turn.question)
      Object.assign(methods, createPortability({ db, directory, conversation, discussion, turns, transaction, revision }))
  return methods.analysisTurn({ turnId })
    },
  }
  Object.assign(methods, createPortability({ db, directory, conversation, discussion, turns, transaction, revision }))
  return methods
}
