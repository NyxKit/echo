import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, lstat, symlink, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
const execute=promisify(execFile),root=await mkdtemp(join(tmpdir(),'echo-synthetic-package-')),prefix=join(root,'prefix')
const source=resolve(process.argv[2]??'build/package')
const env={...process.env,XDG_STATE_HOME:join(root,'state'),XDG_DATA_HOME:join(root,'data'),XDG_CONFIG_HOME:join(root,'config'),DBUS_SESSION_BUS_ADDRESS:'unix:path=/nonexistent-echo-synthetic-session'}
let installed, node, running=false
const run=(file,args,options={})=>execute(file,args,{env,timeout:20000,maxBuffer:20000,...options})
try {
  const target=join(prefix,'opt','echo'),link=join(prefix,'bin','echo'),shortcut=join(prefix,'share','applications','echo.desktop')
  await mkdir(target,{recursive:true});await writeFile(join(target,'foreign.txt'),'Synthetic unrelated content')
  await assert.rejects(run(join(source,'install.sh'),['--prefix',prefix]))
  assert.equal(await readFile(join(target,'foreign.txt'),'utf8'),'Synthetic unrelated content')
  await rm(target,{recursive:true})
  await mkdir(join(prefix,'bin'),{recursive:true});await symlink('/synthetic-unrelated-command',link)
  await assert.rejects(run(join(source,'install.sh'),['--prefix',prefix]))
  assert.equal(await readlink(link),'/synthetic-unrelated-command');await rm(link)
  await mkdir(join(prefix,'share','applications'),{recursive:true});await writeFile(shortcut,'Synthetic unrelated shortcut')
  await assert.rejects(run(join(source,'install.sh'),['--prefix',prefix]))
  assert.equal(await readFile(shortcut,'utf8'),'Synthetic unrelated shortcut');await rm(shortcut)
  await run(join(source,'install.sh'),['--prefix',prefix])
  installed=join(prefix,'opt','echo');node=join(installed,'runtime','node')
  assert.equal((await lstat(join(prefix,'bin','echo'))).isSymbolicLink(),true)
  assert.match(await readFile(join(prefix,'share','applications','echo.desktop'),'utf8'),/Name=Echo/)
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve))
  await run(node,['--input-type=module','-e',`
    import assert from 'node:assert/strict';import sharp from 'sharp';
    import {openLibrary,libraryDirectory} from './server/library/client.mjs';
    const library=await openLibrary(libraryDirectory());
    const owner=await library.resolveOwner({label:'Synthetic Self',evidenceJson:'{"synthetic":true}'});
    const conversation=await library.importConversation({evidenceId:owner.evidenceId,title:'Synthetic',participants:['Synthetic Self'],sourceParts:['{"title":"Synthetic","messages":[{"sender_name":"Synthetic Self","content":"Generated"}]}']});
    const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#f00'}}).png().toBuffer();
    const asset=await library.beginAsset();await library.appendAsset({id:asset.id,bytes});await library.finishAsset({id:asset.id});
    assert.equal((await library.messages({conversationId:conversation.id})).length,1);await library.close();
  `],{cwd:installed})
  await run(join(prefix,'bin','echo'),['--background','--port',String(port)]);running=true
  const first=await run(node,[join(installed,'server','cli.mjs'),'status'])
  assert.match(first.stdout,/Echo is ready/)
  await run(join(prefix,'bin','echo'),['--background'])
  await run(node,[join(installed,'server','cli.mjs'),'quit']);running=false
  await run(join(source,'install.sh'),['--prefix',prefix])
  await run(join(prefix,'bin','echo'),['--background']);running=true
  assert.match((await run(node,[join(installed,'server','cli.mjs'),'status'])).stdout,/Echo is ready/)
  await run(node,['--input-type=module','-e',"import {setLoginEnabled} from './server/autostart.mjs';await setLoginEnabled(true)"],{cwd:installed})
  await run(join(installed,'uninstall.sh'),[]);running=false
  await assert.rejects(lstat(installed));await assert.rejects(lstat(link));await assert.rejects(lstat(shortcut))
  await assert.rejects(lstat(join(root,'config','autostart','echo.desktop')))
  assert.ok((await lstat(join(root,'data','echo','library.sqlite'))).isFile())
  await run(join(source,'install.sh'),['--prefix',prefix])
  await run(node,['--input-type=module','-e',"import assert from 'node:assert/strict';import {openLibrary,libraryDirectory} from './server/library/client.mjs';const library=await openLibrary(libraryDirectory());assert.equal((await library.conversations()).length,1);await library.close()"],{cwd:installed})
  // An interrupted update can leave a marked installation without its runtime.
  // The extracted package must be able to repair it without trusting a PID.
  await rm(join(installed,'runtime'),{recursive:true})
  await run(join(source,'install.sh'),['--prefix',prefix])
  assert.match((await run(node,['--version'])).stdout,/^v24\./)
  // Only matching launchers belong to this installation. Preserve replacements.
  await rm(link);await symlink('/synthetic-unrelated-command',link)
  await writeFile(shortcut,'Synthetic unrelated shortcut')
  await writeFile(join(root,'config','autostart','echo.desktop'),'Synthetic unrelated login entry')
  await writeFile(join(installed,'foreign.txt'),'Synthetic user-added content')
  // Retry an interrupted uninstall from the extracted package after some
  // installed control files have already been removed.
  await rm(join(installed,'runtime'),{recursive:true})
  await rm(join(installed,'server'),{recursive:true})
  await run(join(source,'install.sh'),['--uninstall','--prefix',prefix])
  assert.equal(await readlink(link),'/synthetic-unrelated-command')
  assert.equal(await readFile(shortcut,'utf8'),'Synthetic unrelated shortcut')
  assert.equal(await readFile(join(root,'config','autostart','echo.desktop'),'utf8'),'Synthetic unrelated login entry')
  assert.equal(await readFile(join(installed,'foreign.txt'),'utf8'),'Synthetic user-added content')
  console.log('Synthetic Linux package checks passed: foreign-target/launcher refusal, installer, bundled Node/Sharp/SQLite, repeat launch, shutdown, update, uninstall with matching login cleanup, reinstall with preserved library, interrupted-update/uninstall recovery, and unrelated-file preservation.')
} finally {
  if(running)await run(join(source,'runtime','node'),[join(source,'server','cli.mjs'),'quit']).catch(()=>{})
  await rm(root,{recursive:true,force:true})
}
