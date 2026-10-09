import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readdir, writeFile, readFile, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { openLibrary } from '../server/library/client.mjs'
const cleanup = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(),'echo-synthetic-delete-')), directory = join(root,'library'), original = join(root,'original.json')
  cleanup.push(()=>rm(root,{ recursive:true,force:true }))
  const source = '{"title":"Synthetic","messages":[{"sender_name":"Synthetic Self","content":"Generated","timestamp_ms":1}]}'
  await writeFile(original,source)
  let library = await openLibrary(directory); cleanup.push(()=>library.close())
  const owner = await library.resolveOwner({ label:'Synthetic Self',evidenceJson:'{"synthetic":true}' })
  const conversation = await library.importConversation({ evidenceId:owner.evidenceId,title:'Synthetic',participants:['Synthetic Self'],sourceParts:[source] })
  const asset = await library.beginAsset(); await library.appendAsset({ id:asset.id,bytes:Buffer.from('synthetic bytes') }); await library.finishAsset({ id:asset.id })
  await library.saveDiscussion({ id:randomUUID(),conversationId:conversation.id,title:'Synthetic discussion',draft:'Synthetic draft',scope:'full' })
  const job = await library.imports.create({ kind:'folder' })
  const file = await library.imports.beginFile(job.id,{ path:'messages/thread/message_1.json',size:source.length })
  await library.imports.chunk(job.id,file.id,0,Buffer.from(source))
  return { directory,original,source,owner,get library(){return library},async reopen(){await library.close();library=await openLibrary(directory)} }
}
describe('explicit library deletion and retry',()=>{
  it('removes owned rows, media, drafts and incomplete staging, preserves source files, and permits rebuilding',async()=>{
    const app = await fixture()
    expect(await app.library.deleteLibrary()).toEqual({ deleted:true,cleanupRequired:false })
    expect((await app.library.status()).owner).toBeNull()
    for(const name of ['media','staging','imports']) expect(await readdir(join(app.directory,name))).toEqual([])
    expect(await readFile(app.original,'utf8')).toBe(app.source)
    await app.reopen()
    const owner = await app.library.resolveOwner({ label:'Another synthetic owner',evidenceJson:'{"synthetic":true}' })
    expect(owner.userId).not.toBe(app.owner.userId)
    const imported = await app.library.importConversation({ evidenceId:owner.evidenceId,title:'Synthetic',participants:['Synthetic Self'],sourceParts:[app.source] })
    expect(await app.library.messages({ conversationId:imported.id })).toHaveLength(1)
  })
  it('retains cleanup bookkeeping across restart and does not follow a substituted managed-file symlink',async()=>{
    const app = await fixture(), path = join(app.directory,'media','f'.repeat(64))
    await symlink(app.original,path)
    expect(await app.library.deleteLibrary()).toEqual({ deleted:false,cleanupRequired:true })
    expect((await app.library.status()).cleanupRequired).toBe(true)
    expect(await readFile(app.original,'utf8')).toBe(app.source)
    await app.reopen()
    expect((await app.library.status()).cleanupRequired).toBe(true)
    await expect(app.library.imports.create({ kind:'zip' })).rejects.toThrow()
    await unlink(path)
    expect(await app.library.deleteLibrary()).toEqual({ deleted:true,cleanupRequired:false })
    expect(await readFile(app.original,'utf8')).toBe(app.source)
  })
})
