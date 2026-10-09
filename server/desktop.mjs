import { fork, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { acquireServiceLock } from './service-lock.mjs'
import { ensurePrivateDirectory, stateDirectory, readInstance } from './runtime-state.mjs'
import { hostHelper, windows } from './platform.mjs'
import { launch, instanceStatus, quitInstance } from './launcher.mjs'
import { libraryDirectory } from './library/client.mjs'
import { loginEnabled, setLoginEnabled } from './autostart.mjs'
import { errors, publicErrorCode } from './launcher-errors.mjs'
const ownPath = fileURLToPath(import.meta.url)
export async function ensureTray({ failure } = {}) {
  try { await access(hostHelper()) } catch { return false }
  return new Promise(resolve => {
    const args = ['--tray']
    if (Object.hasOwn(errors, failure)) args.push('--failure', failure)
    const child = fork(ownPath,args,{detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']})
    let settled = false
    function finish(ok) { if(settled)return;settled=true;clearTimeout(timer);if(child.connected)child.disconnect();child.unref();resolve(ok) }
    const timer=setTimeout(()=>{child.kill();finish(false)},8000)
    child.once('message',value=>finish(value?.ready===true))
    child.once('error',()=>finish(false));child.once('exit',()=>finish(false))
  })
}
async function openDesktop() {
  let failure
  try {
    await launch({ directory: stateDirectory(), root: fileURLToPath(new URL('../dist', import.meta.url)), libraryDirectory: libraryDirectory() })
  } catch (error) { failure = error }
  const tray = await ensureTray({ failure: failure && publicErrorCode(failure) })
  if (failure) throw failure
  if (!tray) process.stdout.write('The system tray is unavailable. Use Quit Echo in the browser or pnpm server:quit.\n')
}
async function run() {
  const directory=stateDirectory();await ensurePrivateDirectory(directory)
  let lease
  try { lease=await acquireServiceLock(join(directory,'tray.lock')) }
  catch(error) {
    if(error.message==='service_locked' && process.argv.includes('--controller-open')) {
      try { await launch({directory,root:fileURLToPath(new URL('../dist',import.meta.url)),libraryDirectory:libraryDirectory()}) }
      catch { if(process.connected)process.send({ready:false});return }
    }
    if(process.connected)process.send({ready:error.message==='service_locked'});return
  }
  const failureCode = process.argv[process.argv.indexOf('--failure') + 1]
  let helper, timer, closing=false, busy=false, wasStopping=false, hadReady=false, failureMessage=Object.hasOwn(errors, failureCode) ? errors[failureCode] : ''
  const send = text => { if(helper?.stdin.writable)helper.stdin.write(text.slice(0,490).replace(/[\r\n]/g,' ')+'\n') }
  const publicFailure = error => { failureMessage=errors[publicErrorCode(error)];send('status '+failureMessage) }
  async function start(background) {
    await launch({directory,root:fileURLToPath(new URL('../dist',import.meta.url)),libraryDirectory:libraryDirectory(),background})
    hadReady=true;failureMessage='';send('status Echo is running')
  }
  async function finish() {
    if(closing)return;closing=true;clearInterval(timer);send('exit')
    if(helper) { helper.stdin.end();const kill=setTimeout(()=>helper.kill(),1000);kill.unref() }
    await lease.close()
  }
  try {
    helper=spawn(hostHelper(),windows?['tray']:[],{stdio:['pipe','pipe','ignore'],windowsHide:true})
    helper.stdin.on('error',()=>{})
    helper.once('error',()=>{if(process.connected)process.send({ready:false});void finish()})
    helper.once('exit',()=>void finish())
    const lines=createInterface({input:helper.stdout})
    lines.on('line',async line=>{
      if(line==='ready') {
        if(process.connected)process.send({ready:true})
        try { send('autostart '+Number(await loginEnabled())) } catch { send('status Login startup could not be checked') }
        return
      }
      if(!['open','quit','autostart'].includes(line)||busy||closing)return
      busy=true
      try {
        if(line==='open')await start(false)
        else if(line==='autostart') { const enabled=!(await loginEnabled());await setLoginEnabled(enabled);send('autostart '+Number(enabled)) }
        else {
          const status=await instanceStatus(directory)
          if(status.status!=='unavailable') {send('status Echo is stopping');await quitInstance(directory)}
          await finish()
        }
      } catch(error) { publicFailure(error) }
      finally {busy=false}
    })
    const refresh=async()=>{
      if(busy||closing)return;busy=true
      try {
        const result=await instanceStatus(directory)
        if(result.status==='ready')hadReady=true
        if(result.status==='stopping')wasStopping=true
        if(result.status==='unavailable' && (wasStopping || hadReady && !(await readInstance(directory)))) {await finish();return}
        send('status '+(result.status==='ready'?'Echo is running':result.status==='stopping'?'Echo is stopping':failureMessage||'Echo is unavailable — Open Echo to retry'))
      } catch {send('status Echo is unavailable — Open Echo to retry')}
      finally {busy=false}
    }
    timer=setInterval(()=>void refresh(),2000)
    if(process.argv.includes('--login') || process.argv.includes('--controller-open')) {try{await start(process.argv.includes('--login'))}catch(error){publicFailure(error)}}
    else await refresh()
    process.once('SIGTERM',()=>void finish());process.once('SIGINT',()=>void finish())
  } catch {if(process.connected)process.send({ready:false});await finish()}
}
if(process.argv[1]===ownPath) (process.argv.includes('--open') ? openDesktop() : run()).catch(error=>{
  if(process.connected)process.send({ready:false})
  process.stderr.write(errors[publicErrorCode(error)]+'\n')
  process.exitCode=1
})
