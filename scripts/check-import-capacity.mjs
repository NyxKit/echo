import assert from 'node:assert/strict'
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { openLibrary } from '../server/library/client.mjs'
import { validateExport } from '../server/imports/validate.mjs'
const root=await mkdtemp(join(tmpdir(),'echo-synthetic-capacity-'))
let library
const count=100000,started=performance.now()
async function staged() {
  const jobId=randomUUID(),directory=join(root,'imports',jobId),files=[]
  await mkdir(directory,{recursive:true,mode:0o700})
  for(let part=0;part<4;part++) {
    const messages=Array.from({length:count/4},(_,index)=>({sender_name:'Synthetic Self',timestamp_ms:part*count/4+index,content:'Generated capacity record '+(part*count/4+index),unknown:'x'.repeat(64)}))
    const source=JSON.stringify({title:'Synthetic capacity conversation',owner:{id:'1000001',name:'Synthetic Self'},participants:[{name:'Synthetic Self'}],messages})
    const id=randomUUID();await writeFile(join(directory,id),source,{mode:0o600})
    files.push({id,path:'messages/inbox/synthetic/message_'+(part+1)+'.json',size:Buffer.byteLength(source)})
  }
  await validateExport(directory,files)
  return jobId
}
try {
  library=await openLibrary(root)
  let jobId=await staged()
  assert.equal((await library.previewImport({jobId})).ready,true)
  const first=await library.commitImport({jobId});assert.equal(first.additions,count)
  const initialSeconds=(performance.now()-started)/1000
  console.log("Synthetic initial import completed in "+initialSeconds.toFixed(2)+" seconds")
  jobId=await staged()
  assert.equal((await library.previewImport({jobId})).ready,true)
  const repeat=await library.commitImport({jobId});assert.equal(repeat.additions,0);assert.equal(repeat.revision,first.revision)
  const conversation=(await library.conversations())[0]
  assert.equal(conversation.messageCount,count)
  const page=await library.messages({conversationId:conversation.id,limit:500});assert.equal(page.length,500)
  await library.close();library=await openLibrary(root)
  assert.equal((await library.conversations())[0].messageCount,count)
  console.log(JSON.stringify({syntheticRecords:count,initialSeconds:Number(initialSeconds.toFixed(2)),totalSeconds:Number(((performance.now()-started)/1000).toFixed(2)),maxRssMiB:Math.round(process.resourceUsage().maxRSS/1024),result:'import, repeat, pagination and restart passed'}))
} finally {await library?.close();await rm(root,{recursive:true,force:true})}
