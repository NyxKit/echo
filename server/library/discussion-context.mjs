import { createHash } from 'node:crypto'
import { sourceFields, sourceArrayEntries, sourceRecordEntries, sourceMetadata } from '../../shared/analysis-source.mjs'
import { isTimeScope, timeWindows, timeWindowIndexes, resolveTimeWindows } from '../../shared/context-windows.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = () => { throw new Error('library_context_unavailable') }
const timestamp = value => Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15
const fullUpdateFormat = 'echo-library-context-update-v1'

function metadataIn(parts) {
  const values = new Set()
  for (const source of parts) {
    const fields = sourceFields(source), parsed = JSON.parse(source)
    if (parsed.format === 'echo-library-context-v1') {
      for (const entry of sourceArrayEntries(fields.provenance)) values.add(sourceFields(entry).metadata)
    } else if (parsed.format === fullUpdateFormat) {
      for (const entry of sourceArrayEntries(fields.metadata)) values.add(sourceFields(entry).value)
    } else if (Array.isArray(parsed.messages)) values.add(sourceMetadata(source))
  }
  return values
}

function assetsIn(parts,evidence) {
  const assets = {}
  function retain(reference,values) {
    const id = evidence[reference]
    if (!id) fail()
    assets[id] ??= []
    for (const value of values) if (!assets[id].some(asset=>asset.slot===value.slot && asset.digest===value.digest)) assets[id].push(value)
  }
  parts.forEach((source,part)=>{
    const parsed=JSON.parse(source)
    if (parsed.format==='echo-library-context-v1') for (const entry of parsed.provenance) {
      for (const occurrence of entry.occurrences) retain(`p${part+1}:m${occurrence.recordIndex+1}`,occurrence.assets ?? [])
    }
    else if (parsed.format===fullUpdateFormat) for (const entry of parsed.attachments) retain(entry.reference,entry.assets)
  })
  for (const values of Object.values(assets)) values.sort((a,b)=>a.slot-b.slot || a.digest.localeCompare(b.digest))
  return assets
}

function mergeWindows(windows) {
  const merged = []
  for (const window of windows.sort((a,b) => a[0]-b[0] || a[1]-b[1])) {
    const last = merged.at(-1)
    if (last && window[0] <= last[1]) last[1] = Math.max(last[1],window[1])
    else merged.push([...window])
  }
  return merged
}

// This module sees only server-owned library records. Nothing here dispatches
// provider requests, reads source exports, or changes historical snapshots.
export function createDiscussionContext({ db, snapshot, revision }) {
  const all = (sql,...args) => db.prepare(sql).all(...args)
  const cache = new Map()
  function records(item) {
    const current = revision(), cached = cache.get(item.conversationId)
    if (cached?.revision === current) return cached
    const messages = all('SELECT id,ordinal,timestamp FROM messages WHERE user_id=? AND conversation_id=? ORDER BY ordinal',item.userId,item.conversationId)
    const versions = all(`SELECT v.id,v.message_id AS messageId,v.source_json AS source FROM message_versions v
      JOIN messages m ON m.user_id=v.user_id AND m.id=v.message_id WHERE v.user_id=? AND v.conversation_id=? ORDER BY m.ordinal,v.rowid`,item.userId,item.conversationId)
    const metadata = new Map()
    for (const part of all('SELECT digest,source_json FROM source_parts WHERE user_id=? AND conversation_id=? ORDER BY rowid',item.userId,item.conversationId)) {
      const value = sourceMetadata(part.source_json)
      if (!metadata.has(value)) metadata.set(value,part.digest)
    }
    const assets = new Map()
    for (const row of all(`SELECT DISTINCT o.version_id AS versionId,a.slot,x.digest,x.size FROM occurrence_asset_versions a
      JOIN source_occurrences o ON o.user_id=a.user_id AND o.id=a.occurrence_id JOIN assets x ON x.user_id=a.user_id AND x.id=a.asset_id
      WHERE o.user_id=? AND o.conversation_id=? ORDER BY o.version_id,a.slot,x.digest`,item.userId,item.conversationId)) {
      const { versionId,...asset } = row
      if (!assets.has(versionId)) assets.set(versionId,[])
      assets.get(versionId).push(asset)
    }
    // The original internal importer predates occurrence asset observations.
    for (const row of all(`SELECT v.id AS versionId,a.slot,x.digest,x.size FROM message_assets a
      JOIN assets x ON x.user_id=a.user_id AND x.id=a.asset_id JOIN message_versions v ON v.user_id=a.user_id AND v.message_id=a.message_id
      WHERE a.user_id=? AND a.conversation_id=? AND v.rowid=(SELECT MIN(z.rowid) FROM message_versions z WHERE z.user_id=v.user_id AND z.message_id=v.message_id)
      ORDER BY v.id,a.slot,x.digest`,item.userId,item.conversationId)) {
      const { versionId,...asset } = row
      if (!assets.has(versionId)) assets.set(versionId,[])
      if (!assets.get(versionId).some(value => value.slot===asset.slot && value.digest===asset.digest)) assets.get(versionId).push(asset)
    }
    const generation = hash([versions.map(value=>value.id).sort(),[...metadata.keys()].sort(),[...assets].sort((a,b)=>a[0].localeCompare(b[0]))])
    const result = { revision: current, messages, versions, metadata, assets, generation }
    // Retain one active conversation, not a second in-memory copy of the library.
    cache.clear(); cache.set(item.conversationId,result)
    return result
  }
  function bind(item,payload,referenceMap,data) {
    const byMessage = new Map(), evidence = {}, primary = new Map()
    for (const value of data.versions) {
      if (!byMessage.has(value.messageId)) byMessage.set(value.messageId,new Map())
      byMessage.get(value.messageId).set(value.source,value)
    }
    payload.sourceParts.forEach((source,part) => {
      for (const [index,raw] of sourceRecordEntries(source)) {
        const ref = `p${part+1}:m${Number(index)+1}`, messageId = referenceMap[ref]
        const version = byMessage.get(messageId)?.get(raw)
        if (!version) fail()
        evidence[ref] = version.id
        if (!primary.has(version.id)) primary.set(version.id,ref)
      }
    })
    return { evidence,primary }
  }
  function restore(item,prior,data) {
    const latest = prior.at(-1), payload = JSON.parse(latest.payload_json), savedMap = JSON.parse(latest.reference_map_json)
    const bound = bind(item,payload,savedMap,data)
    // Legacy imports may have kept a map for the entire export even when only
    // a passage was shared. Only actual immutable source records grant coverage.
    const referenceMap = Object.fromEntries(Object.keys(bound.evidence).map(ref=>[ref,savedMap[ref]]))
    if (latest.coverage_json) {
      const coverage = JSON.parse(latest.coverage_json)
      if (coverage.version !== 1 || hash(coverage.evidence) !== hash(bound.evidence)) fail()
      return { payload,referenceMap,...bound,coverage }
    }
    // Migrate lazily from immutable source evidence. Never use today's ordinal
    // positions to interpret a historical citation or a window's timestamp.
    const windows = [], ranges = [], selected = new Set(), anchors = new Set()
    let scope
    for (const row of prior) {
      const saved = JSON.parse(row.payload_json), turn = saved.turn, map = JSON.parse(row.reference_map_json)
      if (turn.context.scope === 'discussion') continue
      scope ??= turn.context.scope
      if (turn.context.scope !== scope) fail()
      const raw = new Map(saved.sourceParts.flatMap((source,part) => sourceRecordEntries(source).map(([index,value])=>[`p${part+1}:m${Number(index)+1}`,value])))
      for (const ref of turn.focus) { if (!map[ref]) fail(); selected.add(map[ref]); anchors.add(map[ref]) }
      if (isTimeScope(scope)) {
        const times = (turn.focus.length ? turn.focus : turn.context.references).map(ref=>JSON.parse(raw.get(ref) ?? '{}').timestamp_ms).filter(timestamp)
        // Snapshots without saved coverage used unshifted windows. Reconstruct
        // those original bounds, never shift them against the current archive.
        if (turn.focus.length) windows.push(...times.map(time=>[time-timeWindows[scope]/2,time+timeWindows[scope]/2]))
        else if (times.length) { const end = times.reduce((a,b)=>Math.max(a,b),-Infinity); windows.push([end-timeWindows[scope],end]) }
      } else if (scope==='surrounding' && !turn.focus.length) {
        const ids=new Set(turn.context.references.map(ref=>map[ref]))
        const included=data.messages.filter(value=>ids.has(value.id))
        if (included.length) ranges.push([included[0].id,included.at(-1).id])
      }
    }
    if (!scope) fail()
    const assets=assetsIn(payload.sourceParts,bound.evidence)
    const digest=hash([scope,[...bound.primary.keys()].map(id=>[id,assets[id] ?? []]).sort((a,b)=>a[0].localeCompare(b[0])),scope==='full'?[...metadataIn(payload.sourceParts)].sort():[]])
    return { payload,referenceMap,...bound,coverage: { version: 1,scope,windows: mergeWindows(windows),ranges,selected: [...selected],anchors: [...anchors],evidence: bound.evidence,assets,digest } }
  }
  function windowFor(data,focus,scope) {
    if (!isTimeScope(scope)) return []
    const indexes = data.messages.flatMap((value,index)=>focus.has(value.id)?[index]:[])
    try { return resolveTimeWindows(data.messages,indexes,timeWindows[scope]) }
    catch (error) {
      if (error.message === 'context_timestamps_unavailable') return []
      throw error
    }
  }
  function build(item,prior,{ question,focus = [],scope,model }) {
    const data = records(item), previous = prior.length ? restore(item,prior,data) : null
    const policy = previous?.coverage.scope ?? scope
    if (previous && scope !== policy) throw new Error('library_context_changed')
    const wanted = new Set(focus), messagesById = new Map(data.messages.map(value=>[value.id,value]))
    if (focus.some(id=>!messagesById.has(id)) || !data.messages.length || !previous && policy==='selected' && !focus.length) throw new Error('library_invalid_input')
    const selected = new Set([...(previous?.coverage.selected ?? []),...focus])
    const anchors = new Set([...(previous?.coverage.anchors ?? []),...focus])
    const windows = mergeWindows([...(previous?.coverage.windows ?? []),...windowFor(data,wanted,policy)])
    const ranges = [...(previous?.coverage.ranges ?? [])]
    const eligible = new Set(previous ? Object.values(previous.referenceMap) : [])
    if (policy==='full') for (const value of data.messages) eligible.add(value.id)
    else if (policy==='selected') for (const id of selected) eligible.add(id)
    else if (isTimeScope(policy)) {
      let positions
      try { positions = timeWindowIndexes(data.messages,data.messages.flatMap((value,index)=>wanted.has(value.id)?[index]:[]),policy) }
      catch {
        if (previous && !focus.length) positions=[]
        else throw new Error('library_context_timestamps_unavailable')
      }
      for (const index of positions) eligible.add(data.messages[index].id)
      // Binary search against merged historical intervals avoids filling gaps.
      for (const value of data.messages) {
        if (!timestamp(value.timestamp)) continue
        let low=0,high=windows.length
        while(low<high) { const mid=(low+high)>>>1; if(windows[mid][0]<=value.timestamp) low=mid+1; else high=mid }
        if(low && value.timestamp<=windows[low-1][1]) eligible.add(value.id)
      }
    } else {
      const focusIds = new Set([...anchors,...focus])
      const positions = data.messages.flatMap((value,index)=>focusIds.has(value.id)?[index]:[])
      if (!focus.length) {
        const start=Math.max(0,data.messages.length-20)
        for(let index=start;index<data.messages.length;index++) eligible.add(data.messages[index].id)
        const range=[data.messages[start].id,data.messages.at(-1).id]
        if (!ranges.some(value=>value[0]===range[0] && value[1]===range[1])) ranges.push(range)
      }
      for (const [start,end] of ranges) {
        const first=messagesById.get(start),last=messagesById.get(end)
        if (!first || !last) fail()
        for(let index=first.ordinal;index<=last.ordinal;index++) eligible.add(data.messages[index].id)
      }
      for (const index of positions) for(let cursor=Math.max(0,index-20);cursor<=Math.min(data.messages.length-1,index+20);cursor++) eligible.add(data.messages[cursor].id)
    }
    for (const id of wanted) eligible.add(id)
    const versions = data.versions.filter(value=>eligible.has(value.messageId))
    const digest = hash([policy,versions.map(value=>[value.id,data.assets.get(value.id) ?? []]).sort((a,b)=>a[0].localeCompare(b[0])),policy==='full'?[...data.metadata.keys()].sort():[]])
    const history = prior.map(row=>({ ...JSON.parse(row.payload_json).turn,answer: row.answer }))
    let sourceParts,referenceMap,evidence,primary,sourceVersion,changed
    if (!previous) {
      const references = new Map(data.versions.map((value,index)=>[value.id,`p1:m${index+1}`]))
      const context = policy==='full' ? { scope: policy } : { scope: policy,references: versions.map(value=>references.get(value.id)) }
      const current = snapshot({ conversationId: item.conversationId,contexts: [context] })
      sourceParts = current.sourceParts; referenceMap = current.referenceMap; sourceVersion = current.sourceVersion
      const bound = bind(item,{ sourceParts },referenceMap,data); evidence=bound.evidence; primary=bound.primary
      changed = false
    } else {
      sourceParts = [...previous.payload.sourceParts]; referenceMap={...previous.referenceMap}; evidence={...previous.evidence}; primary=new Map(previous.primary)
      const additions = versions.filter(value=>!primary.has(value.id)), knownMetadata=metadataIn(sourceParts)
      const metadata = policy==='full' ? [...data.metadata].filter(([value])=>!knownMetadata.has(value)) : []
      const knownAssets = previous.coverage.assets ?? {}
      const assetsChanged = policy==='full' ? versions.filter(value=>hash(knownAssets[value.id] ?? [])!==hash(data.assets.get(value.id) ?? [])) : []
      changed = additions.length>0 || metadata.length>0 || assetsChanged.length>0 || previous.coverage.digest!==undefined && previous.coverage.digest!==digest
      if (additions.length || metadata.length || assetsChanged.length) {
        const bytes=sourceParts.reduce((sum,value)=>sum+Buffer.byteLength(value),0)+additions.reduce((sum,value)=>sum+Buffer.byteLength(value.source),0)
        if (bytes>24_000_000) throw new Error('library_context_too_large')
        const part=sourceParts.length+1
        additions.forEach((value,index)=>{ const ref=`p${part}:m${index+1}`; evidence[ref]=value.id; primary.set(value.id,ref); referenceMap[ref]=value.messageId })
        const records = additions.map(value=>value.source)
        const next = policy==='full'
          ? `{"format":"${fullUpdateFormat}","metadata":[${metadata.map(([value,digest])=>`{"digest":${JSON.stringify(digest)},"value":${value}}`).join(',')}],"attachments":${JSON.stringify(assetsChanged.map(value=>({ reference: primary.get(value.id),assets: data.assets.get(value.id) ?? [] })) )},"messages":[${records.join(',')}]}`
          : `{"messages":{${records.map((raw,index)=>`${JSON.stringify(String(index))}:${raw}`).join(',')}}}`
        sourceParts.push(next)
      }
      sourceVersion = changed ? hash([item.userId,item.conversationId,digest,sourceParts]) : previous.payload.sourceVersion
    }
    const focusReferences = focus.map(id=>primary.get(versions.find(value=>value.messageId===id)?.id))
    if (focusReferences.some(value=>!value)) fail()
    const context = previous && !focus.length && !changed ? { scope: 'discussion' }
      : { scope: policy,...(policy==='full'?{}:{ references: policy==='selected' && focus.length && !changed ? focusReferences : [...new Set([...history.flatMap(value=>value.context.references ?? []),...versions.map(value=>primary.get(value.id))])] }),
        ...(previous && changed ? { refresh: true } : {}) }
    const coverage = { version: 1,scope: policy,windows,ranges,selected: [...selected],anchors: [...anchors],evidence,digest,generation: data.generation,
      assets: Object.fromEntries(versions.map(value=>[value.id,data.assets.get(value.id) ?? []])) }
    return { userId: item.userId,conversationId: item.conversationId,revision: data.revision,sourceVersion,sourceParts,referenceMap,coverage,
      history,turn: { question: question.trim(),focus: focusReferences,context,images: [],excluded: [] },
      model,freshness: { status: !previous?'initial':changed?'update':previous.coverage.generation && previous.coverage.generation!==data.generation?'outside-scope':'existing',scope: policy,generation: digest },
      chosen: data.messages.filter(value=>wanted.has(value.id)) }
  }
  function inferFocus(item,payload,prior) {
    const data = records(item)
    const previous = prior.length ? restore(item,prior,data) : null
    const map = previous?.referenceMap ?? snapshot({ conversationId: item.conversationId }).referenceMap
    return payload.turn.focus.map(ref=>map[ref] ?? fail())
  }
  return { build,inferFocus,clear: ()=>cache.clear() }
}
