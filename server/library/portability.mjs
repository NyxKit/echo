import { randomUUID, createHash } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { validateAnalysis } from '../../shared/analysis-policy.mjs'
import { compactJson, sourceFields, sourceRecordEntries, sourceMessageRecords, sourceMetadata, scopedSourceParts, sourceArrayEntries } from '../../shared/analysis-source.mjs'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const fail = () => { throw new Error('library_portability_invalid') }
const limit = 24_000_000
export function createPortability({ db, directory, conversation, discussion, turns, transaction, revision }) {
  const all = (sql,...args) => db.prepare(sql).all(...args), get = (sql,...args) => db.prepare(sql).get(...args)
  const run = (sql,...args) => db.prepare(sql).run(...args)
  function occurrence(userId,conversationId,digest,index) {
    const part = get('SELECT id FROM source_parts WHERE user_id=? AND conversation_id=? AND digest=?',userId,conversationId,digest)
    if (!part) fail()
    return get(`SELECT o.message_id AS messageId,v.source_json AS source FROM source_occurrences o
      JOIN message_versions v ON v.user_id=o.user_id AND v.id=o.version_id
      WHERE o.user_id=? AND o.part_id=? AND o.source_index=?`,userId,part.id,index) ?? fail()
  }
  function evidence(item,payload,referenceMap) {
    const references = {}
    payload.sourceParts.forEach((source,part) => {
      for (const [index,raw] of sourceRecordEntries(source)) {
        const reference = `p${part+1}:m${Number(index)+1}`
        const row = get(`SELECT p.digest,o.source_index AS sourceIndex FROM source_occurrences o JOIN source_parts p ON p.user_id=o.user_id AND p.id=o.part_id
          JOIN message_versions v ON v.user_id=o.user_id AND v.id=o.version_id
          WHERE o.user_id=? AND o.conversation_id=? AND o.message_id=? AND v.source_json=? ORDER BY o.rowid LIMIT 1`,item.userId,item.conversationId,referenceMap[reference],raw)
        if (!row) fail()
        references[reference] = row
      }
    })
    const parts = {}
    for (const source of payload.sourceParts) for (const entry of JSON.parse(source).provenance ?? []) {
      const row = get('SELECT digest FROM source_parts WHERE user_id=? AND conversation_id=? AND id=?',item.userId,item.conversationId,entry.sourcePartId)
      if (!row) fail()
      parts[entry.sourcePartId] = row.digest
    }
    // Original legacy sources also need metadata validation after re-export.
    const originals = payload.sourceParts.map((source,index) => {
      const candidate = references[`p${index+1}:m1`]?.digest
      const row = candidate && get('SELECT source_json FROM source_parts WHERE user_id=? AND conversation_id=? AND digest=?',item.userId,item.conversationId,candidate)
      return row && compactJson(row.source_json) === compactJson(source) ? candidate : null
    })
    return { references, parts, originals }
  }
  function verify(item,payload,proof) {
    if (!proof || typeof proof !== 'object' || !proof.references || !proof.parts) fail()
    const referenceMap = {}
    payload.sourceParts.forEach((source,partIndex) => {
      const records = new Map(sourceRecordEntries(source))
      for (const [index,raw] of records) {
        const ref = `p${partIndex+1}:m${Number(index)+1}`, binding = proof.references[ref]
        if (!binding || !Number.isSafeInteger(binding.sourceIndex) || !/^[a-f0-9]{64}$/.test(binding.digest)) fail()
        const record = occurrence(item.userId,item.id,binding.digest,binding.sourceIndex)
        if (record.source !== raw) fail()
        referenceMap[ref] = record.messageId
      }
      const parsed = JSON.parse(source), fields = sourceFields(source)
      if (!Array.isArray(parsed.messages)) {
        if (Object.keys(fields).length !== 1) fail()
      } else if (parsed.format === 'echo-library-context-v1') {
        if (payload.sourceParts.length !== 1 || !uuid(parsed.conversationId) || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0 ||
            Object.keys(fields).sort().join(',') !== 'conversationId,format,messages,provenance,revision' || !Array.isArray(parsed.provenance)) fail()
        for (const entrySource of sourceArrayEntries(fields.provenance)) {
          const entry = JSON.parse(entrySource), entryFields = sourceFields(entrySource)
          if (!uuid(entry.sourcePartId) || !uuid(entry.importId) || Object.keys(entryFields).sort().join(',') !== 'importId,metadata,occurrences,sourcePartId') fail()
          const original = get('SELECT source_json FROM source_parts WHERE user_id=? AND conversation_id=? AND digest=?',item.userId,item.id,proof.parts[entry.sourcePartId])
          if (!original || entryFields.metadata !== sourceMetadata(original.source_json)) fail()
          const originalRecords = sourceMessageRecords(original.source_json)
          if (!Array.isArray(entry.occurrences) || entry.occurrences.length !== originalRecords.length) fail()
          const seen = new Set()
          for (const value of entry.occurrences) {
            if (!Number.isSafeInteger(value.sourceIndex) || seen.has(value.sourceIndex) || !uuid(value.messageId) || !uuid(value.versionId) ||
                !Number.isSafeInteger(value.recordIndex) || originalRecords[value.sourceIndex] !== records.get(String(value.recordIndex)) ||
                !['messageId,recordIndex,sourceIndex,versionId','assets,messageId,recordIndex,sourceIndex,versionId'].includes(Object.keys(value).sort().join(','))) fail()
            if (value.assets !== undefined) {
              if (!Array.isArray(value.assets) || value.assets.length > 10000) fail()
              for (const asset of value.assets) {
                if (!Number.isSafeInteger(asset.slot) || !/^[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || Object.keys(asset).sort().join(',') !== 'digest,size,slot') fail()
                if (!get(`SELECT 1 FROM occurrence_asset_versions a JOIN assets x ON x.user_id=a.user_id AND x.id=a.asset_id
                  JOIN source_occurrences o ON o.user_id=a.user_id AND o.id=a.occurrence_id JOIN source_parts p ON p.user_id=o.user_id AND p.id=o.part_id
                  WHERE o.user_id=? AND o.conversation_id=? AND p.digest=? AND o.source_index=? AND a.slot=? AND x.digest=? AND x.size=?`,
                  item.userId,item.id,proof.parts[entry.sourcePartId],value.sourceIndex,asset.slot,asset.digest,asset.size)) fail()
              }
            }
            seen.add(value.sourceIndex)
            const target = occurrence(item.userId,item.id,proof.parts[entry.sourcePartId],value.sourceIndex)
            if (target.messageId !== referenceMap[`p1:m${value.recordIndex+1}`]) fail()
          }
        }
      } else {
        const original = get('SELECT source_json FROM source_parts WHERE user_id=? AND conversation_id=? AND digest=?',item.userId,item.id,proof.originals?.[partIndex])
        if (!original || compactJson(original.source_json) !== compactJson(source)) fail()
      }
    })
    return referenceMap
  }
  function legacy(item,value) {
    let originals, referenceMap
    for (const imported of all('SELECT id FROM imports WHERE user_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 10000',item.userId,item.id)) {
      const parts = all(`SELECT p.id,p.source_json FROM import_source_parts i JOIN source_parts p ON p.user_id=i.user_id AND p.id=i.part_id
        WHERE i.user_id=? AND i.import_id=? ORDER BY i.ordinal`,item.userId,imported.id)
      if (hash(parts.map(part=>part.source_json)) !== value.sourceVersion) continue
      originals = parts.map(part=>part.source_json); referenceMap = {}
      parts.forEach((part,index) => { for (const row of all('SELECT source_index,message_id FROM source_occurrences WHERE user_id=? AND part_id=?',item.userId,part.id)) referenceMap[`p${index+1}:m${row.source_index+1}`] = row.message_id })
      break
    }
    if (!originals) fail()
    return value.threads.map(thread => {
      const history = [], saved = []
      for (const turn of thread.turns ?? []) {
        const input = { ...turn, context: value.version === 1 ? { scope: 'full' } : turn.context }
        const sourceParts = scopedSourceParts(originals,[...history.map(item=>item.context),input.context])
        const payload = validateAnalysis({ requestId: randomUUID(), model: 'gpt-6.1-sol', sourceVersion: value.sourceVersion,
          sourceParts, contextVersion: hash(sourceParts), history: [...history], turn: input })
        saved.push({ payload, answer: turn.answer, status: turn.status, referenceMap })
        if (turn.status === 'complete') history.push({ ...payload.turn, answer: turn.answer })
      }
      return { ...thread, scope: value.version === 1 ? 'full' : thread.scope, turns: saved }
    })
  }
  return {
    exportDiscussions({ conversationId }) {
      const item = conversation(conversationId)
      const threads = all('SELECT id FROM discussions WHERE user_id=? AND conversation_id=? ORDER BY rowid LIMIT 51',item.userId,item.id).map(row => {
        const saved = discussion(row.id)
        return { title: saved.title, draft: saved.draft, scope: saved.scope, turns: turns(row.id).map(turn => {
          const payload = JSON.parse(turn.payload_json)
          return { payload, answer: turn.answer, status: turn.status === 'sending' ? 'interrupted' : turn.status,
            evidence: turn.source_evidence_json ? JSON.parse(turn.source_evidence_json) : evidence(saved,payload,JSON.parse(turn.reference_map_json)) }
        }) }
      })
      if (!threads.length || threads.length > 50) throw new Error('library_limit')
      const text = JSON.stringify({ version: 5, conversationEvidence: get('SELECT digest FROM source_parts WHERE user_id=? AND conversation_id=? ORDER BY rowid LIMIT 1',item.userId,item.id), threads })
      if (Buffer.byteLength(text) > limit) throw new Error('library_context_too_large')
      return { text }
    },
    importDiscussions({ conversationId, text }) {
      const item = conversation(conversationId)
      if (typeof text !== 'string' || Buffer.byteLength(text) > limit) fail()
      let value, threads
      try {
        value = JSON.parse(text)
        if (![1,2,3,4,5].includes(value.version) || !Array.isArray(value.threads) || !value.threads.length || value.threads.length > 50) fail()
        if (value.version === 5 && !get('SELECT 1 FROM source_parts WHERE user_id=? AND conversation_id=? AND digest=?',item.userId,item.id,value.conversationEvidence?.digest)) fail()
        threads = value.version === 5 ? value.threads : legacy(item,value)
        for (const thread of threads) {
          if (typeof thread.title !== 'string' || thread.title.length > 160 || typeof thread.draft !== 'string' || thread.draft.length > 16000 ||
              !['selected','surrounding','full'].includes(thread.scope) || !Array.isArray(thread.turns) || thread.turns.length > 100) fail()
          const history = []; let sourceVersion
          for (const turn of thread.turns) {
            const payload = validateAnalysis(turn.payload)
            if (typeof turn.answer !== 'string' || turn.answer.length > 500000 || !['complete','failed','canceled','interrupted'].includes(turn.status) ||
                JSON.stringify(payload.history) !== JSON.stringify(history) || hash(payload.sourceParts) !== payload.contextVersion ||
                sourceVersion && sourceVersion !== payload.sourceVersion) fail()
            sourceVersion = payload.sourceVersion
            turn.payload = payload
            if (value.version === 5) turn.referenceMap = verify(item,payload,turn.evidence)
            if (turn.status === 'complete') history.push({ ...payload.turn, answer: turn.answer })
          }
        }
      } catch { fail() }
      if (get('SELECT COUNT(*) AS count FROM discussions WHERE user_id=? AND conversation_id=?',item.userId,item.id).count + threads.length > 500) throw new Error('library_limit')
      const space = statfsSync(directory,{ bigint:true })
      if (space.bavail*space.bsize < BigInt(Buffer.byteLength(text)*3+256*1024*1024)) throw new Error('library_disk_full')
      return transaction(() => {
        const ids = []
        for (const thread of threads) {
          const id = randomUUID(); ids.push(id)
          run('INSERT INTO discussions (id,user_id,conversation_id,title,draft,scope,source_version) VALUES (?,?,?,?,?,?,?)',
            id,item.userId,item.id,thread.title,thread.draft,thread.scope,thread.turns.at(-1)?.payload.sourceVersion ?? null)
          thread.turns.forEach((turn,sequence) => {
            const snapshotId = randomUUID(), turnId = randomUUID()
            const payload = { ...turn.payload, requestId: turnId }
            run('INSERT INTO analysis_snapshots VALUES (?,?,?,?,?,?,?,?,?,?)',snapshotId,item.userId,item.id,id,revision(),'imported',payload.model,JSON.stringify(payload),JSON.stringify(turn.referenceMap),turn.evidence ? JSON.stringify(turn.evidence) : null)
            run('INSERT INTO analysis_turns VALUES (?,?,?,?,?,?,?,?)',turnId,item.userId,id,snapshotId,sequence,turn.status,turn.answer,turn.status==='interrupted'?'outcome_unknown':null)
          })
        }
        return { ids }
      })
    },
  }
}
