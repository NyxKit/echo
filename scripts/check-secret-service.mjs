import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, copyFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { createSecureStore } from '../server/secure-store.mjs'
const execute = promisify(execFile)
if (!process.argv.includes('--inside')) {
  if (process.platform !== 'linux') throw new Error('This isolated Secret Service check requires Linux')
  const root = await mkdtemp(join(tmpdir(), 'echo-synthetic-keyring-'))
  try {
    for (const name of ['scripts','server','data/keyrings','config','state','runtime','control']) await mkdir(join(root,name),{recursive:true,mode:0o700})
    for (const name of ['secure-store','service-lock','platform']) await copyFile('server/'+name+'.mjs',join(root,'server',name+'.mjs'))
    await copyFile('scripts/check-secret-service.mjs',join(root,'scripts/check-secret-service.mjs'))
    await copyFile(process.execPath,join(root,'node'));await chmod(join(root,'node'),0o700)
    // Mount only OS executables and the generated test root. Neither the real
    // home directory nor the desktop session bus is available in this sandbox.
    const child=spawn('bwrap',['--unshare-all','--die-with-parent','--new-session','--clearenv',
      '--ro-bind','/usr','/usr','--tmpfs','/usr/share/dbus-1/services','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib','/lib64',
      '--dir','/etc','--ro-bind','/etc/passwd','/etc/passwd','--ro-bind','/etc/group','/etc/group',
      '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--tmpfs','/home','--bind',root,'/work','--chdir','/work',
      '--setenv','PATH','/usr/bin','--setenv','LANG','C.UTF-8','--setenv','XDG_DATA_HOME','/work/data',
      '--setenv','XDG_CONFIG_HOME','/work/config','--setenv','XDG_STATE_HOME','/work/state','--setenv','XDG_RUNTIME_DIR','/work/runtime',
      '--setenv','GNOME_KEYRING_CONTROL','/work/control','--setenv','ECHO_SYNTHETIC_KEYRING','1',
      'dbus-run-session','--','/work/node','/work/scripts/check-secret-service.mjs','--inside'],{stdio:['ignore','inherit','inherit']})
    const timer=setTimeout(()=>child.kill('SIGKILL'),45000)
    try { const [code]=await once(child,'exit');assert.equal(code,0) } finally {clearTimeout(timer)}
  } finally {await rm(root,{recursive:true,force:true})}
} else {
  assert.equal(process.env.ECHO_SYNTHETIC_KEYRING,'1');assert.equal(process.env.XDG_DATA_HOME,'/work/data')
  let daemon,store
  async function start() {
    daemon=spawn('gnome-keyring-daemon',['--foreground','--unlock','--components=secrets','--control-directory=/work/control'],{stdio:['pipe','ignore','ignore']})
    daemon.stdin.end('echo-synthetic-only\n')
    for(let i=0;i<100;i++) {
      if(daemon.exitCode!==null)throw new Error('Synthetic keyring daemon exited')
      try {await execute('gdbus',['call','--session','--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.GetNameOwner','org.freedesktop.secrets'],{timeout:1000});return}
      catch {await delay(50)}
    }
    throw new Error('Synthetic keyring readiness timed out')
  }
  async function stop() {if(daemon&&daemon.exitCode===null){const exited=once(daemon,'exit');daemon.kill();await exited}}
  try {
    await start()
    store=createSecureStore(undefined,{directory:'/work/state/connection'})
    assert.equal(await store.read(),undefined)
    const record={synthetic:true,value:'generated🧪'.repeat(7000)}
    await store.write(record);assert.ok(JSON.stringify(await store.read())===JSON.stringify(record))
    await store.close();await stop();await start()
    store=createSecureStore(undefined,{directory:'/work/state/connection'})
    assert.ok(JSON.stringify(await store.read())===JSON.stringify(record))
    await store.write({synthetic:true,disconnected:true});assert.deepEqual(await store.read(),{synthetic:true,disconnected:true})
    await execute('gdbus',['call','--session','--dest','org.freedesktop.secrets','--object-path','/org/freedesktop/secrets',
      '--method','org.freedesktop.Secret.Service.Lock',"['/org/freedesktop/secrets/collection/login']"],{timeout:2000})
    await assert.rejects(store.read(),/secure_store_unavailable/)
    await assert.rejects(store.write({synthetic:true,unexpected:true}),/secure_store_unavailable/)
    await store.close();await stop();await start()
    store=createSecureStore(undefined,{directory:'/work/state/connection'})
    assert.deepEqual(await store.read(),{synthetic:true,disconnected:true})
    await store.close();await stop()
    // A missing service cannot read a record from the real desktop: its bus
    // and filesystem were never mounted. Bound the synthetic activation probe.
    store=createSecureStore((command,args,options)=>{
      const child=spawn(command,args,options),timer=setTimeout(()=>child.kill(),2000)
      child.once('close',()=>clearTimeout(timer));return child
    },{directory:'/work/state/connection'})
    await assert.rejects(store.read(),/secure_store_unavailable/)
    console.log('Synthetic Secret Service checks passed: isolated long Unicode storage, replacement, daemon restart persistence, disconnect record, locked-store preservation, and unavailable-store refusal.')
  } finally {await store?.close();await stop()}
}
