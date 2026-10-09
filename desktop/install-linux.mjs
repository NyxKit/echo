import { cp, mkdir, lstat, readFile, writeFile, rm, symlink, readlink, readdir, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { autostartPath, desktopArgument, desktopEntry } from './server/autostart.mjs'
import { instanceStatus, quitInstance } from './server/launcher.mjs'
import { stateDirectory } from './server/runtime-state.mjs'
const source=dirname(fileURLToPath(import.meta.url))
const args=process.argv.slice(2)
const uninstall=args[0]==='--uninstall'
if(uninstall)args.shift()
if(args.length && (args.length!==2||args[0]!=='--prefix'||!args[1].startsWith('/')))throw new Error('Use [--uninstall] [--prefix /absolute/installation/prefix]')
const prefix=resolve(args[1]??join(homedir(),'.local'))
const destination=join(prefix,'opt','echo'),bin=join(prefix,'bin'),applications=join(prefix,'share','applications')
if(process.platform!=='linux'||process.arch!=='x64')throw new Error('This package requires x86-64 Linux')
if(!uninstall&&resolve(source)===destination)throw new Error('Run the installer from the extracted package')
async function info(path) {try{return await lstat(path)}catch(error){if(error.code==='ENOENT')return;throw error}}
async function matchingFile(path,expected) {
  const entry=await info(path)
  return !!entry&&entry.isFile()&&!entry.isSymbolicLink()&&await readFile(path,'utf8')===expected
}
const marker=join(destination,'.echo-install'),existing=await info(destination)
let installed=false
if(existing) {
  if(!existing.isDirectory()||existing.isSymbolicLink())throw new Error('The installation location is not an Echo installation')
  installed=await matchingFile(marker,'echo-v1\n')
  if(!installed&&(uninstall||(await readdir(destination)).length))throw new Error('The installation location is not an Echo installation')
}
const link=join(bin,'echo'),shortcut=join(applications,'echo.desktop')
const entryText='[Desktop Entry]\nType=Application\nName=Echo\nComment=Your local conversation library\nExec='+desktopArgument(join(destination,'echo'))+'\nIcon=mail-message-new\nTerminal=false\nCategories=Utility;\n'
const linkInfo=await info(link)
const ownsLink=!!linkInfo?.isSymbolicLink()&&resolve(dirname(link),await readlink(link))===join(destination,'echo')
const ownsShortcut=await matchingFile(shortcut,entryText)
if(!uninstall&&((linkInfo&&!ownsLink)||((await info(shortcut))&&!ownsShortcut)))throw new Error('The Echo command or application shortcut is already occupied by another installation')
if(installed) {
  // Use this package's control code so an interrupted installation remains
  // repairable even when its runtime or server files have been removed.
  try {
    const directory=stateDirectory()
    if((await instanceStatus(directory)).status!=='unavailable')await quitInstance(directory)
  } catch { throw new Error('Echo could not confirm shutdown. Close Echo and retry the installer.') }
}
const ownedFiles=['runtime','native','server','shared','dist','node_modules','package.json','LICENSES.txt','echo','install-linux.mjs','uninstall.sh']
if(uninstall) {
  if(!installed)throw new Error('No Echo installation was found at this prefix')
  const login=autostartPath()
  if(await matchingFile(login,desktopEntry(join(destination,'runtime','node'),join(destination,'server','desktop.mjs'))))await rm(login)
  if(ownsLink)await rm(link)
  if(ownsShortcut)await rm(shortcut)
  for(const name of ownedFiles)await rm(join(destination,name),{recursive:true,force:true})
  await rm(marker)
  try{await rmdir(destination)}catch(error){if(error.code!=='ENOTEMPTY')throw error}
  console.log('Echo application files and matching launchers were removed. Your library and separate provider connection were retained.')
} else {
await mkdir(destination,{recursive:true,mode:0o700})
await writeFile(join(destination,'.echo-install'),'echo-v1\n',{mode:0o600})
for(const name of ownedFiles) {
  await rm(join(destination,name),{recursive:true,force:true})
  await cp(join(source,name),join(destination,name),{recursive:true,dereference:false,preserveTimestamps:true})
}
await mkdir(bin,{recursive:true});await mkdir(applications,{recursive:true})
if(ownsLink)await rm(link)
await symlink(join(destination,'echo'),link)
await writeFile(shortcut,entryText,{mode:0o644})
console.log('Echo is installed. Open Echo from your applications menu. Start at login remains opt-in in the tray menu.')
}
