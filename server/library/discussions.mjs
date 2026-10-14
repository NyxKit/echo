import { normalizeDiscussionSubject } from '../../shared/discussion-subject.mjs'
import { createPortability } from './portability.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { attachmentReferences } from '../imports/validate.mjs'
import { validateAnalysis, contextScopes } from '../../shared/analysis-policy.mjs'
import { createDiscussionContext } from './discussion-context.mjs'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const fail = code => { throw new Error(code) }
const json = value => JSON.stringify(value)
export function createDiscussions({ db, directory, owner, conversation, snapshot, transaction, revision }) {
  const get = (sql, ...values) => db.prepare(sql).get(...values)
  const all = (sql, ...values) => db.prepare(sql).all(...values)
  const run = (sql, ...values) => db.prepare(sql).run(...values)
  const contextBuilder = createDiscussionContext({ db,snapshot,revision })
  // No accepted inference is automatically redispatched after restart.
  run("UPDATE analysis_turns SET status='interrupted',error='outcome_unknown' WHERE status='sending'")
  const noTurns = `NOT EXISTS (SELECT 1 FROM analysis_turns t WHERE t.user_id=discussions.user_id AND t.discussion_id=discussions.id)
    AND NOT EXISTS (SELECT 1 FROM analysis_snapshots s WHERE s.user_id=discussions.user_id AND s.discussion_id=discussions.id)`
  for (const row of all(`SELECT id,draft FROM discussions WHERE title='New discussion' AND ${noTurns}`)) {
    if (!row.draft.trim()) run('DELETE FROM discussions WHERE id=?', row.id)
  }
  function discussion(id) {
    if (!uuid(id)) fail('library_invalid_input')
    return get('SELECT id,user_id AS userId,conversation_id AS conversationId,title,draft,scope,draft_revision AS draftRevision,source_version AS sourceVersion FROM discussions WHERE user_id=? AND id=?', owner().userId, id) ?? fail('library_not_found')
  }
  function turn(id) {
    if (!uuid(id)) fail('library_invalid_input')
    return get(`SELECT t.id,t.user_id AS userId,t.discussion_id AS discussionId,t.sequence,t.status,t.answer,t.error,s.payload_json,s.reference_map_json,s.source_evidence_json,s.coverage_json,s.library_revision AS libraryRevision,s.provider_account AS providerAccount
      FROM analysis_turns t JOIN analysis_snapshots s ON s.user_id=t.user_id AND s.id=t.snapshot_id WHERE t.user_id=? AND t.id=?`, owner().userId, id) ?? fail('library_not_found')
  }
  function turns(discussionId) {
    const item = discussion(discussionId)
    return all(`SELECT t.id,t.user_id AS userId,t.sequence,t.status,t.answer,t.error,s.payload_json,s.reference_map_json,s.source_evidence_json,s.coverage_json
      FROM analysis_turns t JOIN analysis_snapshots s ON s.user_id=t.user_id AND s.id=t.snapshot_id WHERE t.user_id=? AND t.discussion_id=? ORDER BY t.sequence`, item.userId, item.id)
  }
  function publicTurn(row) { const payload = JSON.parse(row.payload_json); return { ...payload.turn, id: row.id, userId: row.userId, sequence: row.sequence, referenceMap: JSON.parse(row.reference_map_json), answer: row.answer, status: row.status, error: row.error } }
  const subjectColumns = `SELECT d.id,d.title,d.draft_revision AS draftRevision,s.model,json_extract(s.payload_json,'$.turn.question') AS question
    FROM discussions d JOIN analysis_turns t ON t.user_id=d.user_id AND t.discussion_id=d.id AND t.sequence=0
    JOIN analysis_snapshots s ON s.user_id=t.user_id AND s.id=t.snapshot_id
    WHERE d.user_id=? AND t.status='complete'`
  const needsSubject = row => row && typeof row.question === 'string' &&
    (row.title === 'New discussion' || row.title === row.question.slice(0,60))
  const methods = {
    clearAnalysisCache() { contextBuilder.clear() },
    discardEmptyDiscussion({ discussionId, draftRevision }) {
      if (!uuid(discussionId) || !Number.isSafeInteger(draftRevision) || draftRevision < 1) fail('library_invalid_input')
      const { userId } = owner()
      // The caller cleared its local draft; reject any newer saved draft or submitted turn.
      const result = run(`DELETE FROM discussions WHERE user_id=? AND id=? AND draft_revision=? AND title='New discussion' AND ${noTurns}`,
        userId, discussionId, draftRevision)
      return { deleted: result.changes === 1 || !get('SELECT 1 FROM discussions WHERE user_id=? AND id=?', userId, discussionId) }
    },
    discussionSubjectCandidates({ after = '' } = {}) {
      if (after && !uuid(after)) fail('library_invalid_input')
      const rows = all(subjectColumns + ' AND d.id>? ORDER BY d.id LIMIT 100', owner().userId, after)
      return { items: rows.filter(needsSubject).map(row => row.id), after: rows.length === 100 ? rows.at(-1).id : null }
    },
    discussionSubjectInput({ discussionId }) {
      if (!uuid(discussionId)) fail('library_invalid_input')
      const row = get(subjectColumns + ' AND d.id=?', owner().userId, discussionId)
      return needsSubject(row) ? row : null
    },
    saveDiscussionSubject({ discussionId, title, expectedTitle, draftRevision }) {
      if (!uuid(discussionId) || typeof title !== 'string' || normalizeDiscussionSubject(title) !== title || typeof expectedTitle !== 'string' ||
          !Number.isSafeInteger(draftRevision) || draftRevision < 1) fail('library_invalid_input')
      const result = run(`UPDATE discussions SET title=?,draft_revision=draft_revision+1
        WHERE user_id=? AND id=? AND title=? AND draft_revision=?`, title, owner().userId, discussionId, expectedTitle, draftRevision)
      return { updated: result.changes === 1 }
    },
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
    contextStatus({ discussionId,focus = [],scope }) {
      const item = discussion(discussionId)
      if (!Array.isArray(focus) || focus.length>500 || new Set(focus).size!==focus.length || !focus.every(uuid) || !contextScopes.includes(scope)) fail('library_invalid_input')
      const prior = turns(item.id).filter(row=>row.status==='complete')
      return contextBuilder.build(item,prior,{ question: 'Local context status',focus,scope,model: 'local-status' }).freshness
    },
    contextInput({ discussionId, question, focus = [], scope, model }) {
      const item = discussion(discussionId)
      if (typeof question !== 'string' || !question.trim() || question.length > 16000 || !Array.isArray(focus) || focus.length > 500 || new Set(focus).size !== focus.length ||
          !focus.every(uuid) || !contextScopes.includes(scope) || typeof model !== 'string' || model.length > 160) fail('library_invalid_input')
      const prior = turns(item.id).filter(row => row.status === 'complete')
      const current = contextBuilder.build(item,prior,{ question,focus,scope,model })
      const { chosen,turn: turnInput,referenceMap } = current
      const references = new Map(turnInput.focus.map(ref=>[referenceMap[ref],ref]))
      const attachments = chosen.flatMap(value => {
        const variants = get(`SELECT COUNT(*) AS count FROM (SELECT a.slot FROM occurrence_asset_versions a JOIN source_occurrences o ON o.user_id=a.user_id AND o.id=a.occurrence_id
          WHERE o.user_id=? AND o.message_id=? GROUP BY a.slot HAVING COUNT(DISTINCT a.asset_id)>1)`,item.userId,value.id).count
        if (variants) turnInput.excluded.push({ reference: references.get(value.id), reason: 'Conflicting attachment observations are retained. Only the first stored attachment bytes are prepared for this selection.' })
        const raw = JSON.parse(get('SELECT source_json FROM message_versions WHERE user_id=? AND message_id=? ORDER BY rowid LIMIT 1',item.userId,value.id).source_json)
        const assets = all('SELECT asset_id AS assetId,slot,kind FROM message_assets WHERE user_id=? AND message_id=? ORDER BY slot',item.userId,value.id)
        return attachmentReferences(raw).map((asset,slot)=>({ kind: asset.kind, assetId: assets.find(value=>value.slot===slot)?.assetId ?? null,
          remote: /^https?:/i.test(asset.uri), animated: /\.gif(?:$|[?#])/i.test(asset.uri), reference: references.get(value.id) }))
      })
      return { ...current,turn: turnInput,attachments }
    },
    acceptTurn({ discussionId, payload, providerAccount, input }) {
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
      const focus = input?.focus ?? contextBuilder.inferFocus(item,validated,completed)
      const scope = input?.scope ?? completed.map(row=>JSON.parse(row.payload_json).turn.context.scope).find(value=>value!=='discussion') ?? validated.turn.context.scope
      const expected = methods.contextInput({ discussionId,question: validated.turn.question,model: validated.model,focus,scope })
      if (expected.sourceVersion !== validated.sourceVersion || json(expected.sourceParts) !== json(validated.sourceParts) ||
          json(expected.turn.context) !== json(validated.turn.context) || json(expected.turn.focus) !== json(validated.turn.focus)) fail('library_context_changed')
      const libraryRevision = expected.revision, referenceMap = expected.referenceMap, sourceEvidence = null
      const space = statfsSync(directory, { bigint: true })
      if (space.bavail * space.bsize < BigInt(Buffer.byteLength(encoded) * 3 + 256 * 1024 * 1024)) fail('library_disk_full')
      return transaction(() => {
        const snapshotId = randomUUID(), id = validated.requestId
        run('INSERT INTO analysis_snapshots (id,user_id,conversation_id,discussion_id,library_revision,provider_account,model,payload_json,reference_map_json,source_evidence_json,coverage_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)', snapshotId, item.userId, item.conversationId, item.id, libraryRevision, providerAccount, validated.model, encoded, json(referenceMap), sourceEvidence,json(expected.coverage))
        run("INSERT INTO analysis_turns (id,user_id,discussion_id,snapshot_id,sequence,status) VALUES (?,?,?,?,?,'sending')", id, item.userId, item.id, snapshotId, prior.length)
        run('UPDATE discussions SET source_version=?,title=CASE WHEN title=? THEN ? ELSE title END WHERE user_id=? AND id=?', validated.sourceVersion, 'New discussion', validated.turn.question.slice(0,60), item.userId, item.id)
        run("UPDATE discussions SET draft='',draft_revision=draft_revision+1 WHERE user_id=? AND id=? AND trim(draft)=?", item.userId, item.id, validated.turn.question)
        return { accepted: true, ...methods.analysisTurn({ turnId: id }) }
      })
    },
    updateTurn({ turnId, answer, status = 'sending', error = null }) {
      const row = turn(turnId)
      if (row.status !== 'sending') fail('library_invalid_input')
      if (typeof answer !== 'string' || answer.length > 500_000 || !['sending','complete','failed','canceled','interrupted'].includes(status) ||
          error !== null && !['outcome_unknown','canceled','provider_failed','storage_failed','expired','quota','provider_context'].includes(error)) fail('library_invalid_input')
      run('UPDATE analysis_turns SET answer=?,status=?,error=? WHERE user_id=? AND id=?', answer, status, error, row.userId, row.id)
      Object.assign(methods, createPortability({ db, directory, conversation, discussion, turns, transaction, revision }))
  return methods.analysisTurn({ turnId })
    },
  }
  Object.assign(methods, createPortability({ db, directory, conversation, discussion, turns, transaction, revision }))
  return methods
}
