import { readFile, mkdir, writeFile, unlink, rename } from 'node:fs/promises'
import { join, isAbsolute, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { windows, hostHelper } from './platform.mjs'
const execute = promisify(execFile)
const script = fileURLToPath(new URL('./desktop.mjs', import.meta.url))
const marker = '# Managed by Echo\n'
export function desktopArgument(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('autostart_unavailable')
  return '"' + value.replaceAll('\\','\\\\\\\\').replaceAll('"','\\\\"').replaceAll('`','\\\\`').replaceAll('$','\\\\$').replaceAll('%','%%') + '"'
}
export function autostartPath(env = process.env) {
  return join(env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(homedir(),'.config'),'autostart','echo.desktop')
}
export function desktopEntry(node = process.execPath, target = script) {
  return marker + '[Desktop Entry]\nType=Application\nName=Echo\nComment=Start the local Echo library in the background\nExec=' +
    desktopArgument(node) + ' ' + desktopArgument(target) + ' --login\nTerminal=false\nIcon=mail-message-new\n'
}
export async function loginEnabled({ env = process.env } = {}) {
  if (windows) return (await execute(hostHelper(),['autostart-status'],{ windowsHide:true,timeout:5000 })).stdout === '1'
  try { const text = await readFile(autostartPath(env),'utf8'); return text.startsWith(marker) && text === desktopEntry() }
  catch(error) { if(error.code==='ENOENT')return false;throw new Error('autostart_unavailable') }
}
export async function setLoginEnabled(enabled,{ env = process.env } = {}) {
  if (typeof enabled !== 'boolean') throw new Error('autostart_unavailable')
  if (windows) {
    await execute(hostHelper(),enabled?['autostart-enable',process.execPath,script]:['autostart-disable'],{windowsHide:true,timeout:5000});return
  }
  const path = autostartPath(env)
  let existing
  try { existing = await readFile(path,'utf8') } catch(error) { if(error.code!=='ENOENT')throw new Error('autostart_unavailable') }
  if (existing && !existing.startsWith(marker)) throw new Error('autostart_unavailable')
  if (!enabled) { if(existing)await unlink(path);return }
  await mkdir(dirname(path),{recursive:true})
  const temp = path + '.tmp'
  try { await writeFile(temp,desktopEntry(),{mode:0o600,flag:'wx'});await rename(temp,path) }
  finally { await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error}) }
}
