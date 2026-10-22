import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { openLibrary } from '../server/library/client.mjs'
import { prepareContext } from '../server/library/prepare-context.mjs'
import { createAnalysisJobs } from '../server/library/analysis-jobs.mjs'
import { validateExport } from '../server/imports/validate.mjs'
import { sourceRecordEntries } from '../shared/analysis-source.mjs'
import { timeWindows } from '../shared/context-windows.mjs'

// Every record, archive and database in this suite is generated here.
const cleanup = [], account = 'a'.repeat(64), day = 86_400_000
afterEach(async()=>{ for (const close of cleanup.splice(0).reverse()) await close() })
const message = (time,content = `Generated ${time}`,extra = {}) => ({ sender_name: 'Synthetic Self',timestamp_ms: time,content,...extra })
const source = (messages,extra = {}) => JSON.stringify({ title: 'Synthetic refresh',owner: { id: 'synthetic-owner',name: 'Synthetic Self' },participants: [{ name: 'Synthetic Self' }],...extra,messages })
const rawRecords = payload => payload.sourceParts.flatMap(part=>sourceRecordEntries(part).map(([,raw])=>raw))
const contents = payload => rawRecords(payload).map(raw=>JSON.parse(raw).content)

async function fixture(initial,scope = 'week',initialFiles = [],initialParts = [source(initial)]) {
  const directory = await mkdtemp(join(tmpdir(),'echo-synthetic-refresh-'))
  cleanup.push(()=>rm(directory,{ recursive: true,force: true }))
  let library = await openLibrary(directory)
  cleanup.push(()=>library.close())
  async function stage(parts,extra = []) {
    const jobId = randomUUID(),root = join(directory,'imports',jobId)
    await mkdir(root,{ recursive: true,mode: 0o700 })
    const files = []
    for (const item of [...parts.map((bytes,index)=>({ path: `messages/inbox/synthetic/message_${index+1}.json`,bytes })),...extra]) {
      const id = randomUUID(),bytes = Buffer.from(item.bytes)
      await writeFile(join(root,id),bytes,{ mode: 0o600 }); files.push({ id,path: item.path,size: bytes.length })
    }
    await validateExport(root,files)
    return { jobId,preview: await library.previewImport({ jobId }) }
  }
  async function importParts(parts,extra,choices = {}) {
    const staged = await stage(parts,extra)
    await library.commitImport({ jobId: staged.jobId,...choices })
    return staged
  }
  await importParts(initialParts,initialFiles)
  const conversationId = (await library.conversations())[0].id,discussionId = randomUUID()
  await library.saveDiscussion({ id: discussionId,conversationId,title: 'Synthetic discussion',draft: 'Synthetic question',scope })
  const input = (focus = [],question = 'Synthetic question') => ({ discussionId,question,focus,scope,model: 'synthetic-model' })
  async function prepare(focus = [],question) { return (await prepareContext(library,input(focus,question))).payload }
  async function accept(payload,focus = []) { return library.acceptTurn({ discussionId,payload,providerAccount: account,input: input(focus,payload.turn.question) }) }
  async function complete(payload,focus = []) {
    const turn = await accept(payload,focus)
    await library.updateTurn({ turnId: turn.id,answer: 'Synthetic answer [[p1:m1]]',status: 'complete' })
    return turn
  }
  return { directory,conversationId,discussionId,get library() { return library },stage,importParts,input,prepare,accept,complete,
    messages: ()=>library.messages({ conversationId,limit: 500 }),
    status: (focus = [])=>library.contextStatus({ discussionId,scope,focus }),
    async reopen() { await library.close(); library = await openLibrary(directory) } }
}

describe('automatic conversation context refresh',()=>{
  it('persists individual prompt clocks across follow-ups and restart without moving archive windows',async()=>{
    const app=await fixture([message(1)]),firstClock={ sentAt: '2026-10-14T14:00:00.000Z',timeZone: 'Europe/Brussels' },nextClock={ sentAt: '2026-10-15T06:00:00.000Z',timeZone: 'Europe/Brussels' }
    const first=(await prepareContext(app.library,{ ...app.input(),promptTime: firstClock })).payload
    await app.complete(first); await app.reopen()
    expect((await app.library.discussion({ discussionId: app.discussionId })).turns[0].promptTime).toEqual(firstClock)
    const next=(await prepareContext(app.library,{ ...app.input([], 'Yesterday we had a synthetic lunch.'),promptTime: nextClock })).payload
    expect(next.history[0].promptTime).toEqual(firstClock); expect(next.turn.promptTime).toEqual(nextClock)
    expect(next.sourceParts).toEqual(first.sourceParts); expect(next.sourceVersion).toBe(first.sourceVersion)
    expect(next.turn.context).toEqual({ scope: 'discussion' })
    await app.complete(next); await app.reopen()
    expect((await app.library.discussion({ discussionId: app.discussionId })).turns.map(value=>value.promptTime)).toEqual([firstClock,nextClock])
  })
  it.each(Object.keys(timeWindows))('refreshes %s against the latest archive timestamp while retaining historical records',async scope=>{
    const first = message(0),app = await fixture([first],scope)
    const original = await app.prepare(); await app.complete(original)
    const end = timeWindows[scope]*3,latest = message(end),boundary = message(end-timeWindows[scope]),gap = message(timeWindows[scope])
    await app.importParts([source([first,gap,boundary,latest])])
    expect((await app.status()).status).toBe('update')
    const next = await app.prepare([], 'What changed in the latest exchange?')
    expect(contents(next)).toEqual([first.content,boundary.content,latest.content])
    expect(next.turn.context).toMatchObject({ scope,refresh: true })
    expect(next.turn.focus).toEqual([]); expect(next.turn.images).toEqual([])
    expect(next.history[0]).toMatchObject({ ...original.turn,answer: 'Synthetic answer [[p1:m1]]' })
    expect(next.sourceParts[0]).toBe(original.sourceParts[0])
    await app.complete(next)
    expect((await app.status()).status).toBe('existing')
    expect((await app.prepare()).turn.context).toEqual({ scope: 'discussion' })
  })

  it('ignores duplicate, repartitioned and unrelated evidence and allows an unchanged preparation',async()=>{
    const records = [message(1),message(2),message(3)],app = await fixture(records,'full')
    const initial = await app.prepare(); await app.complete(initial)
    const pending = await app.prepare()
    await app.importParts([source(records)])
    expect((await app.status()).status).toBe('existing')
    await app.importParts([source(records.slice(0,1)),source(records.slice(1))])
    expect((await app.status()).status).toBe('existing')
    const other = source([message(99,'Another conversation')],{ title: 'Synthetic other thread',participants: [{ name: 'Synthetic Other' }] })
    await app.importParts([other],[],{ conversations: { } })
    expect((await app.status()).status).toBe('existing')
    expect((await app.prepare()).sourceParts).toEqual(initial.sourceParts)
    expect((await app.accept(pending)).accepted).toBe(true)
  })

  it('keeps selected-only bounded and supports adding a newly imported explicit selection',async()=>{
    const first=message(1),app=await fixture([first],'selected'),id=(await app.messages())[0].id
    await app.complete(await app.prepare([id]),[id])
    await app.importParts([source([first,message(2)])])
    expect((await app.status()).status).toBe('outside-scope')
    expect(contents(await app.prepare())).toEqual([first.content])
    const newId=(await app.messages())[1].id
    const added=await app.prepare([newId])
    expect(contents(added)).toEqual([first.content,'Generated 2'])
    expect(added.turn.focus).toEqual(['p2:m1'])
    expect(added.turn.context.scope).toBe('selected')
    await app.complete(added,[newId])
    expect((await app.prepare()).turn.context).toEqual({ scope: 'discussion' })
    await expect(app.library.contextInput({ ...app.input(),scope: 'full' })).rejects.toThrow('library_context_changed')
  })

  it('rejects forged automatic expansion outside selected-only coverage',async()=>{
    const records=[message(1),message(2)],app=await fixture(records,'selected'),focus=[(await app.messages())[0].id]
    await app.complete(await app.prepare(focus),focus)
    const forged=await app.prepare()
    forged.sourceParts.push(`{"messages":{"0":${JSON.stringify(records[1])}}}`)
    forged.contextVersion=createHash('sha256').update(JSON.stringify(forged.sourceParts)).digest('hex')
    forged.turn.context={ scope: 'selected',refresh: true,references: ['p1:m1','p2:m1'] }
    await expect(app.accept(forged)).rejects.toThrow('library_context_changed')
    expect((await app.library.discussion({ discussionId: app.discussionId })).turns).toHaveLength(1)
  })

  it('adds backfills within historical surrounding windows and preserves disjoint gaps and citation identities',async()=>{
    const records=[message(10*day),message(40*day),message(70*day)],app=await fixture(records)
    const ids=(await app.messages()).map(value=>value.id)
    const initial=await app.prepare([ids[0],ids[2]]); await app.complete(initial,[ids[0],ids[2]])
    const saved=await app.library.discussion({ discussionId: app.discussionId })
    await app.importParts([source([message(1*day),...records,message(12*day),message(30*day),message(68*day)])])
    const next=await app.prepare()
    expect(contents(next)).toEqual([records[0].content,records[2].content,'Generated 1036800000','Generated 5875200000'])
    expect(next.history[0].focus).toEqual(initial.turn.focus)
    expect(next.sourceParts[0]).toBe(initial.sourceParts[0])
    const accepted=await app.complete(next)
    const current=await app.library.discussion({ discussionId: app.discussionId })
    expect(current.turns[0]).toEqual(saved.turns[0])
    expect(current.turns.find(value=>value.id===accepted.id).referenceMap['p1:m1']).toBe(ids[0])
  })

  it.each(Object.keys(timeWindows))('retains resolved %s edge windows when imports extend both archive boundaries',async scope=>{
    const duration=timeWindows[scope]
    const records=[0,0.25,1,2,3,3.75,4].map(time=>message(time*duration))
    const app=await fixture(records,scope),ids=(await app.messages()).map(value=>value.id),focus=[ids[1],ids[5]]
    const initial=await app.prepare(focus)
    expect(contents(initial)).toEqual([0,0.25,1,3,3.75,4].map(time=>message(time*duration).content))
    expect((await app.library.contextInput(app.input(focus))).coverage.windows).toEqual([[0,duration],[3*duration,4*duration]])
    await app.complete(initial,focus)
    const saved=await app.library.discussion({ discussionId: app.discussionId })
    await app.reopen()
    await app.importParts([source([...records,...[-1,-0.125,0.9,1.5,2.5,3.1,4.125,7,8].map(time=>message(time*duration))])])
    const next=await app.prepare()
    expect(contents(next)).toEqual([
      ...[0,0.25,1,3,3.75,4].map(time=>message(time*duration).content),
      ...[0.9,3.1,7,8].map(time=>message(time*duration).content),
    ])
    expect((await app.library.contextInput(app.input())).coverage.windows).toEqual([[0,duration],[3*duration,4*duration],[7*duration,8*duration]])
    expect(next.sourceParts[0]).toBe(initial.sourceParts[0])
    expect(next.history[0]).toMatchObject(initial.turn)
    await app.complete(next)
    await app.reopen()
    expect((await app.library.discussion({ discussionId: app.discussionId })).turns[0]).toEqual(saved.turns[0])
    expect((await app.status()).status).toBe('existing')
  })

  it('restores legacy centered windows without shifting them against newer archive bounds',async()=>{
    const records=[message(10*day),message(40*day),message(70*day)],app=await fixture(records)
    const focus=[(await app.messages())[0].id],initial=await app.prepare(focus)
    // Only the anchor was shared, identically to the old equal-halves behavior.
    expect(contents(initial)).toEqual([records[0].content])
    await app.complete(initial,focus)
    await app.library.close()
    const db=new DatabaseSync(join(app.directory,'library.sqlite'))
    db.exec('DROP TABLE conversation_context; DROP TABLE conversation_identities; ALTER TABLE analysis_snapshots DROP COLUMN coverage_json; PRAGMA user_version=4'); db.close()
    await app.reopen()
    await app.importParts([source([...records,message(day),message(8*day),message(15*day)])])
    const next=await app.prepare()
    expect(contents(next)).toEqual([records[0].content,message(8*day).content,records[2].content])
    expect((await app.library.contextInput(app.input())).coverage.windows).toEqual([[6.5*day,13.5*day],[63*day,70*day]])
    expect(next.sourceParts[0]).toBe(initial.sourceParts[0])
    expect(next.history[0]).toMatchObject(initial.turn)
    await app.complete(next)
  })

  it('retains distinct equal-timestamp messages and new observations of shared messages without rounding unknown fields',async()=>{
    const records=[message(1),message(2),message(3)],app=await fixture(records,'selected')
    const focus=[(await app.messages())[1].id],initial=await app.prepare(focus); await app.complete(initial,focus)
    const edited=source([records[0],message(2,records[1].content,{ reactions: [{ reaction: 'synthetic',actor: 'Synthetic Self' }],unknown: 'SYNTHETIC_BIG_NUMBER' }),records[2],message(3,'Distinct equal timestamp')]).replace('"SYNTHETIC_BIG_NUMBER"','900719925474099312345')
    await app.importParts([edited])
    const next=await app.prepare()
    expect(rawRecords(next)).toHaveLength(2)
    expect(rawRecords(next)[1]).toContain('900719925474099312345')
    expect(next.sourceParts[0]).toBe(initial.sourceParts[0]); expect(next.turn.focus).toEqual([])
    await app.complete(next)
    const saved=await app.library.discussion({ discussionId: app.discussionId })
    expect(saved.turns[1].referenceMap['p2:m1']).toBe(focus[0])
    expect(contents(next)).not.toContain('Distinct equal timestamp')
  })

  it('rejects a relevant import race before dispatch, keeps the draft and requires another Send',async()=>{
    const first=message(1),app=await fixture([first]); await app.complete(await app.prepare())
    let dispatches=0,mutate=true
    const jobs=createAnalysisJobs({ library: app.library,provider: { prepareJob: async()=>{
      if(mutate) { mutate=false; await app.importParts([source([first,message(2)])]) }
      return { providerAccount: account,run: async({ onEvent })=>{ dispatches++; await onEvent({ type: 'complete' }) } }
    } } }); cleanup.push(()=>jobs.close())
    const saved=await app.library.discussion({ discussionId: app.discussionId })
    await app.library.saveDiscussion({ ...saved,draft: 'Keep this draft' })
    const pending=await jobs.prepare({},app.input([], 'Keep this draft'))
    await expect(jobs.accept({}, { discussionId: app.discussionId,payload: pending.payload })).rejects.toThrow('library_context_changed')
    expect(dispatches).toBe(0)
    expect((await app.library.discussion({ discussionId: app.discussionId })).draft).toBe('Keep this draft')
    const fresh=await jobs.prepare({},app.input([], 'Keep this draft'))
    await jobs.accept({}, { discussionId: app.discussionId,payload: fresh.payload })
    await expect.poll(()=>dispatches).toBe(1)
  })

  it('keeps accepted context immutable during an import and uses only completed coverage after failures and restart',async()=>{
    const first=message(1),app=await fixture([first]); await app.complete(await app.prepare())
    await app.importParts([source([first,message(2)])])
    const pending=await app.prepare(),turn=await app.accept(pending)
    await app.importParts([source([first,message(2),message(3)])])
    await app.library.updateTurn({ turnId: turn.id,answer: 'Partial synthetic answer',status: 'failed' })
    expect((await app.status()).status).toBe('update')
    await app.reopen()
    expect((await app.status()).status).toBe('update')
    const next=await app.prepare(); expect(contents(next)).toEqual([first.content,'Generated 2','Generated 3'])
    expect(next.history).toHaveLength(1)
    const saved=await app.library.discussion({ discussionId: app.discussionId })
    expect(saved.turns[1].context).toEqual(pending.turn.context)
    await app.complete(next)
    expect((await app.status()).status).toBe('existing')
  })

  it('does not treat a completed older in-flight response as coverage of a later import',async()=>{
    const first=message(1),app=await fixture([first]); await app.complete(await app.prepare())
    const old=await app.prepare(),turn=await app.accept(old)
    await app.importParts([source([first,message(2)])])
    await app.library.updateTurn({ turnId: turn.id,answer: 'Finished original context',status: 'complete' })
    expect((await app.status()).status).toBe('update')
    expect(contents(await app.prepare())).toEqual([first.content,'Generated 2'])
  })

  it.each(['failed','canceled','interrupted'])('keeps new evidence pending after a %s turn',async status=>{
    const first=message(1),app=await fixture([first]); await app.complete(await app.prepare())
    await app.importParts([source([first,message(2)])])
    const pending=await app.prepare(),turn=await app.accept(pending)
    await app.library.updateTurn({ turnId: turn.id,answer: 'Synthetic partial',status,error: status==='interrupted'?'outcome_unknown':null })
    await app.reopen()
    expect((await app.status()).status).toBe('update')
    const next=await app.prepare()
    expect(contents(next)).toEqual([first.content,'Generated 2']); expect(next.history).toHaveLength(1)
    await app.complete(next)
  })

  it('retains submitted image copies and never sends imported replacement bytes without a new selection',async()=>{
    const photo=message(1,'Synthetic image',{ photos: [{ uri: 'messages/inbox/synthetic/photos/pixel.png' }] })
    const bytes=await sharp({ create: { width: 2,height: 2,channels: 3,background: '#ff0000' } }).png().toBuffer()
    const replacement=await sharp({ create: { width: 3,height: 3,channels: 3,background: '#0000ff' } }).png().toBuffer()
    const file=bytes=>[{ path: 'messages/inbox/synthetic/photos/pixel.png',bytes }]
    const app=await fixture([photo],'full',file(bytes)),focus=[(await app.messages())[0].id]
    const initial=await app.prepare(focus); expect(initial.turn.images).toHaveLength(1); await app.complete(initial,focus)
    await app.importParts([source([photo])],file(replacement))
    expect((await app.status()).status).toBe('update')
    const next=await app.prepare()
    expect(next.turn.images).toEqual([]); expect(next.turn.focus).toEqual([])
    expect(next.history[0].images).toEqual(initial.turn.images)
    expect(next.sourceParts[1]).toContain('attachments')
    await app.complete(next)
    const exported=await app.library.exportDiscussions({ conversationId: app.conversationId })
    const imported=await app.library.importDiscussions({ conversationId: app.conversationId,text: exported.text })
    const migrated=await prepareContext(app.library,{ ...app.input(),discussionId: imported.ids[0] })
    expect(migrated.payload.turn.context).toEqual({ scope: 'discussion' })
    expect(migrated.payload.history[0].images).toEqual(initial.turn.images)
    const explicit=await app.prepare(focus)
    expect(explicit.turn.images).toHaveLength(1)
    expect(explicit.turn.excluded.some(value=>value.reason.includes('Conflicting attachment'))).toBe(true)
  })

  it('blocks a refreshed union above the transfer limit without dropping historical context or the draft',async()=>{
    const records=Array.from({ length: 4 },(_,index)=>message(index+1,`Synthetic large ${index} `+'x'.repeat(6_100_000)))
    const parts=records.map(value=>source([value])),app=await fixture(records.slice(0,2),'full',[],parts.slice(0,2))
    await app.complete(await app.prepare())
    const saved=await app.library.discussion({ discussionId: app.discussionId })
    await app.library.saveDiscussion({ ...saved,draft: 'Keep oversized context draft' })
    // Each synthetic part remains below the importer's eight-MiB JSON limit.
    await app.importParts(parts)
    await expect(app.prepare()).rejects.toThrow('library_context_too_large')
    const current=await app.library.discussion({ discussionId: app.discussionId })
    expect(current.draft).toBe('Keep oversized context draft'); expect(current.turns).toHaveLength(1)
  },30_000)

  it('refreshes full metadata losslessly and migrates refreshed evidence through existing internal portability',async()=>{
    const first=message(1),app=await fixture([first],'full'); await app.complete(await app.prepare())
    const changed=source([first,message(2)],{ note: 'SYNTHETIC_BIG_NUMBER' }).replace('"SYNTHETIC_BIG_NUMBER"','900719925474099312345')
    await app.importParts([changed]); const next=await app.prepare()
    expect(next.sourceParts[1]).toContain('"note":900719925474099312345')
    await app.complete(next)
    const exported=await app.library.exportDiscussions({ conversationId: app.conversationId })
    const imported=await app.library.importDiscussions({ conversationId: app.conversationId,text: exported.text })
    const migrated=await app.library.discussion({ discussionId: imported.ids[0] })
    expect(migrated.turns).toHaveLength(2)
    expect((await prepareContext(app.library,{ ...app.input(),discussionId: migrated.id })).payload.turn.context).toEqual({ scope: 'discussion' })
    const tampered=JSON.parse(exported.text)
    const payload=tampered.threads[0].turns[1].payload
    payload.sourceParts[1]=payload.sourceParts[1].replace('900719925474099312345','7')
    await expect(app.library.importDiscussions({ conversationId: app.conversationId,text: JSON.stringify(tampered) })).rejects.toThrow('library_portability_invalid')
  })

  it('refreshes all-time metadata even when no new message versions exist',async()=>{
    const records=[message(1)],app=await fixture(records,'full'),initial=await app.prepare()
    await app.complete(initial)
    await app.importParts([source(records,{ note: 'Synthetic metadata observation' })])
    expect((await app.status()).status).toBe('update')
    const next=await app.prepare()
    expect(rawRecords(next)).toHaveLength(1)
    expect(next.sourceParts[1]).toContain('Synthetic metadata observation')
    expect(JSON.parse(next.sourceParts[1]).messages).toEqual([])
    await app.complete(next)
    expect((await app.status()).status).toBe('existing')
  })

  it('reconstructs legacy coverage from immutable references after older records shift ordinal positions',async()=>{
    const first=message(10*day),app=await fixture([first]); const initial=await app.prepare(); await app.complete(initial)
    // Build a disposable v4 database by removing later migration additions.
    await app.library.close()
    const db=new DatabaseSync(join(app.directory,'library.sqlite'))
    db.exec('DROP TABLE conversation_context; DROP TABLE conversation_identities; ALTER TABLE analysis_snapshots DROP COLUMN coverage_json; PRAGMA user_version=4'); db.close()
    await app.reopen()
    await app.importParts([source([message(1*day),first,message(11*day)])])
    const next=await app.prepare()
    expect(contents(next)).toEqual([first.content,'Generated 950400000'])
    expect(next.history[0].context.references).toEqual(initial.turn.context.references)
    await app.complete(next)
    await app.reopen(); expect((await app.status()).status).toBe('existing')
  })

  it('does not grant coverage from unused references in a legacy selected-only discussion',async()=>{
    const records=[message(1),message(2),message(3)],app=await fixture(records,'selected')
    const originals=[source(records)],sourceVersion=createHash('sha256').update(JSON.stringify(originals)).digest('hex')
    const imported=await app.library.importDiscussions({ conversationId: app.conversationId,text: JSON.stringify({ version: 4,sourceVersion,
      threads: [{ title: 'Synthetic legacy selection',draft: '',scope: 'selected',turns: [{ question: 'Synthetic selected question',focus: ['p1:m2'],
        context: { scope: 'selected',references: ['p1:m2'] },images: [],excluded: [],answer: 'Synthetic legacy answer',status: 'complete' }] }] }) })
    await app.importParts([source([...records,message(4)])])
    const input={ ...app.input(),discussionId: imported.ids[0] },next=await prepareContext(app.library,input)
    expect(contents(next.payload)).toEqual([records[1].content])
    expect(next.payload.turn.context).toEqual({ scope: 'discussion' })
    expect(Object.keys(next.referenceMap)).toEqual(['p1:m2'])
  })

  it('retains undated explicit messages without inventing a time window',async()=>{
    const app=await fixture([message(null,'Undated synthetic')]),focus=[(await app.messages())[0].id]
    await expect(app.prepare()).rejects.toThrow('library_context_timestamps_unavailable')
    await app.complete(await app.prepare(focus),focus)
    expect((await app.prepare()).turn.context).toEqual({ scope: 'discussion' })
    await app.importParts([source([message(null,'Undated synthetic'),message(day)])])
    expect(contents(await app.prepare())).toEqual(['Undated synthetic',`Generated ${day}`])
  })

  it('preserves legacy count windows and detects backfills between their original stable boundaries',async()=>{
    const records=Array.from({ length: 30 },(_,index)=>message(index)),app=await fixture(records,'surrounding')
    const original=await app.prepare(); expect(contents(original)).toHaveLength(20); await app.complete(original)
    const newer=Array.from({ length: 40 },(_,index)=>message(100+index))
    await app.importParts([source([...records,...newer])]); await app.complete(await app.prepare())
    await app.importParts([source([...records,...newer,message(15,'Synthetic count-window backfill')])])
    const next=await app.prepare()
    expect(contents(next)).toContain('Synthetic count-window backfill')
  })
})
