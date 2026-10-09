import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
export const windows = process.platform === 'win32'
export function hostHelper() {
  const name = windows ? 'echo-host.exe' : 'echo-host'
  const installed = fileURLToPath(new URL('../native/' + name, import.meta.url))
  return existsSync(installed) ? installed : fileURLToPath(new URL('../build/' + name, import.meta.url))
}
export function windowsData(env = process.env) {
  const root = env.LOCALAPPDATA
  if (!root || !isAbsolute(root)) throw new Error('state_unavailable')
  return join(root,'Echo')
}
export function credentialDirectory() { return windows ? join(windowsData(),'connection') : join(homedir(),'.local','state','echo-chatgpt') }
export function checkPrivate(path, info) {
  if (info.isSymbolicLink()) throw new Error('state_unavailable')
  if (windows) {
    try { execFileSync(hostHelper(),['private-check',path],{ stdio:'ignore',windowsHide:true,timeout:5000 }) }
    catch { throw new Error('state_unavailable') }
  } else if(info.uid !== process.getuid() || info.mode & 0o077) throw new Error('state_unavailable')
}
export function ensureDirectory(path) {
  let existing
  try { existing = lstatSync(path) } catch(error) { if(error.code!=='ENOENT')throw error }
  if(existing && (!existing.isDirectory() || existing.isSymbolicLink()))throw new Error('state_unavailable')
  mkdirSync(path,{recursive:true,mode:0o700})
  if(windows && !existing) {
    try { execFileSync(hostHelper(),['private-protect',path],{stdio:'ignore',windowsHide:true,timeout:5000}) }
    catch { throw new Error('state_unavailable') }
  }
  checkPrivate(path,lstatSync(path))
}
