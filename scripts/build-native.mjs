import { mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
await mkdir('build',{recursive:true})
function run(command,args) {
  const result=spawnSync(command,args,{stdio:'inherit',shell:false})
  if(result.error||result.status!==0)throw new Error('Native helper compilation failed')
}
const target=process.env.ECHO_DESKTOP_TARGET??process.platform
if(target==='linux') {
  const flags=spawnSync('pkg-config',['--cflags','--libs','gio-2.0'],{encoding:'utf8'})
  if(flags.status!==0)throw new Error('Install the GLib/GIO development package')
  run(process.env.CC || 'gcc',['-Wall','-Wextra','-Werror','-O2','desktop/linux-tray.c','-o','build/echo-host',...flags.stdout.trim().split(/\s+/)])
} else if(target==='win32') {
  run(process.env.CC || 'gcc',['-Wall','-Wextra','-O2','-municode','-mwindows','desktop/windows-host.c','-o','build/echo-host.exe','-lshell32','-ladvapi32','-lbcrypt','-luser32'])
} else throw new Error('This desktop platform is not supported')
