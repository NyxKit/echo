import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { openLibrary } from '../server/library/client.mjs'
import { prepareContext } from '../server/library/prepare-context.mjs'
import { createAnalysisJobs } from '../server/library/analysis-jobs.mjs'
const cleanup = []
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse()) await fn()})
async function fixture(bytes) {
  const root=await mkdtemp(join(tmpdir(),'echo-synthetic-prepare-'))
  cleanup.push(()=>rm(root,{recursive:true,force:true}))
  const library=await openLibrary(root);cleanup.push(()=>library.close())
  const owner=await library.resolveOwner({label:'Synthetic Self',evidenceJson:'{"synthetic":true}'})
  const asset=await library.beginAsset();await library.appendAsset({id:asset.id,bytes});const saved=await library.finishAsset({id:asset.id})
  const source=JSON.stringify({title:'Synthetic',messages:[{sender_name:'Synthetic Self',content:'Generated',photos:[{uri:'photo.png'}],timestamp_ms:1}]})
  const conversation=await library.importConversation({evidenceId:owner.evidenceId,title:'Synthetic',participants:['Synthetic Self'],sourceParts:[source],attachments:[{part:0,index:0,slot:0,kind:'image',assetId:saved.id}]})
  const discussionId=randomUUID();await library.saveDiscussion({id:discussionId,conversationId:conversation.id,title:'New discussion',draft:'Question',scope:'selected'})
  return {library,conversation,owner,input:{discussionId,question:'Question',focus:[(await library.messages({conversationId:conversation.id}))[0].id],scope:'selected',model:'synthetic-model'}}
}
describe('server-owned context and image preparation',()=>{
  it('decodes synthetic static images, resizes them and retains only PNG pixels',async()=>{
    const bytes=await sharp({create:{width:1600,height:800,channels:3,background:'#f00'}}).jpeg().withMetadata({exif:{IFD0:{Artist:'Synthetic artist'}}}).toBuffer()
    const app=await fixture(bytes),{payload,referenceMap}=await prepareContext(app.library,app.input)
    expect(payload.turn.images).toHaveLength(1)
    const image=payload.turn.images[0], metadata=await sharp(Buffer.from(image.dataUrl.split(',')[1],'base64')).metadata()
    expect([image.width,image.height]).toEqual([1024,512]);expect(metadata.format).toBe('png');expect(metadata.exif).toBeUndefined()
    expect(referenceMap['p1:m1']).toBe(app.input.focus[0])
  })
  it('excludes active and corrupt image content without decoding it as another format',async()=>{
    const app=await fixture(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>synthetic</script></svg>'))
    const {payload}=await prepareContext(app.library,app.input)
    expect(payload.turn.images).toEqual([]);expect(payload.turn.excluded).toHaveLength(1)
  })
  it('rejects altered preparations and account changes without dispatching',async()=>{
    const app=await fixture(Buffer.from('invalid image'));let account='a'.repeat(64),dispatches=0
    const jobs=createAnalysisJobs({library:app.library,provider:{currentAccount:async()=>account,prepareJob:async()=>({providerAccount:account,run:async()=>{dispatches++}})}})
    cleanup.push(()=>jobs.close())
    const {payload}=await jobs.prepare({},app.input)
    await expect(jobs.accept({}, {discussionId:app.input.discussionId,payload:{...payload,turn:{...payload.turn,question:'Changed'}}})).rejects.toThrow('library_context_changed')
    account='b'.repeat(64)
    await expect(jobs.accept({}, {discussionId:app.input.discussionId,payload})).rejects.toThrow('library_context_changed')
    expect(dispatches).toBe(0)
  })
  it('rejects a context when an import commits during provider preparation',async()=>{
    const app=await fixture(Buffer.from('invalid image'));let dispatches=0
    const jobs=createAnalysisJobs({library:app.library,provider:{prepareJob:async()=>{
      await app.library.importConversation({evidenceId:app.owner.evidenceId,title:'Synthetic later history',participants:['Synthetic Self'],sourceParts:['{"title":"Synthetic later history","messages":[{"sender_name":"Synthetic Self","content":"Synthetic later import","timestamp_ms":2}]}']})
      return {providerAccount:'a'.repeat(64),run:async()=>{dispatches++}}
    }}})
    cleanup.push(()=>jobs.close())
    const {payload}=await jobs.prepare({},app.input)
    await expect(jobs.accept({}, {discussionId:app.input.discussionId,payload})).rejects.toThrow('library_context_changed')
    expect(dispatches).toBe(0)
    expect((await app.library.discussion({discussionId:app.input.discussionId})).turns).toHaveLength(0)
  })
  it('waits for an in-flight acceptance on shutdown and saves its cancellation',async()=>{
    const app=await fixture(Buffer.from('invalid image'))
    let entered,release,aborted=false
    const entering=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve})
    const jobs=createAnalysisJobs({library:{...app.library,acceptTurn:async input=>{entered();await gate;return app.library.acceptTurn(input)}},provider:{prepareJob:async()=>({providerAccount:'a'.repeat(64),run:async({signal})=>{
      await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true})})
      aborted=true;throw new Error('aborted')
    }})}})
    cleanup.push(()=>jobs.close())
    const {payload}=await jobs.prepare({},app.input)
    const accepting=jobs.accept({}, {discussionId:app.input.discussionId,payload})
    await entering
    const closing=jobs.close();release()
    await accepting;await closing
    expect(aborted).toBe(true)
    expect((await app.library.analysisTurn({turnId:payload.requestId})).status).toBe('canceled')
  })
})
