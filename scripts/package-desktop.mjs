import { cp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import yauzl from 'yauzl'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
const platform=process.env.ECHO_DESKTOP_TARGET??process.platform,windows=platform==='win32',version='24.21.0'
if(!['linux','win32'].includes(platform)||process.arch!=='x64')throw new Error('Packaging supports Linux and Windows x86-64')
const stage=resolve('build/package'),download=resolve('build/downloads')
async function run(command,args,options={}) {
  await new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:'inherit',shell:process.platform==='win32'&&command==='pnpm',...options});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Packaging command failed')))})
}
async function fetchFile(url,path) {
  const response=await fetch(url);if(!response.ok)throw new Error('Runtime download failed')
  const bytes=Buffer.from(await response.arrayBuffer());await writeFile(path,bytes);return bytes
}
await mkdir(download,{recursive:true});await mkdir('release',{recursive:true})
await run(process.execPath,['scripts/build-native.mjs'])
await run('pnpm',['build'])
await rm(stage,{recursive:true,force:true});await mkdir(stage)
await writeFile(join(stage,'.echo-install'),'echo-v1\n')
for(const name of ['server','shared','dist','package.json','pnpm-lock.yaml'])await cp(name,join(stage,name),{recursive:true})
await writeFile(join(stage,'pnpm-workspace.yaml'),'nodeLinker: hoisted\nsupportedArchitectures:\n  os: [ '+platform+' ]\n  cpu: [ x64 ]\n  libc: [ glibc ]\n')
await run('pnpm',['install','--prod','--frozen-lockfile','--ignore-scripts','--config.node-linker=hoisted'],{cwd:stage})
await rm(join(stage,'pnpm-lock.yaml'));await rm(join(stage,'pnpm-workspace.yaml'))
const archive='node-v'+version+'-'+(windows?'win-x64.zip':'linux-x64.tar.xz')
const base='https://nodejs.org/dist/v'+version+'/'
const checks=await (await fetch(base+'SHASUMS256.txt')).text()
const expected=checks.split('\n').find(line=>line.trim().endsWith(' '+archive))?.split(/\s+/)[0]
if(!/^[a-f0-9]{64}$/.test(expected??''))throw new Error('Published runtime checksum unavailable')
const bytes=await fetchFile(base+archive,join(download,archive))
if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('Runtime checksum mismatch')
if (!windows) await run('tar',['-xf',join(download,archive),'-C',download])
else await new Promise((resolve,reject) => {
  yauzl.open(join(download,archive),{lazyEntries:true},(error,zip) => {
    if(error)return reject(error)
    const prefix='node-v'+version+'-win-x64/'
    let installed=0
    zip.on('error',reject);zip.on('end',()=>installed===2?resolve():reject(new Error('Incomplete runtime')))
    zip.on('entry',entry=>{
      if(![prefix+'node.exe',prefix+'LICENSE'].includes(entry.fileName)){zip.readEntry();return}
      zip.openReadStream(entry,async(error,stream)=>{
        if(error)return reject(error)
        try {await mkdir(join(download,prefix),{recursive:true});await pipeline(stream,createWriteStream(join(download,entry.fileName)));installed++;zip.readEntry()}
        catch(error){zip.close();reject(error)}
      })
    });zip.readEntry()
  })
})
const unpacked=join(download,'node-v'+version+'-'+(windows?'win-x64':'linux-x64'))
await mkdir(join(stage,'runtime'));await cp(join(unpacked,windows?'node.exe':'bin/node'),join(stage,'runtime',windows?'node.exe':'node'))
await mkdir(join(stage,'native'));await cp('build/echo-host'+(windows?'.exe':''),join(stage,'native','echo-host'+(windows?'.exe':'')))
await writeFile(join(stage,'LICENSES.txt'),'Echo bundles Node.js '+version+'.\nNode license:\n'+await readFile(join(unpacked,'LICENSE'),'utf8')+'\nDependency licenses are retained in node_modules.\n')
const metadata=JSON.parse(await readFile(join(stage,'package.json'),'utf8'));delete metadata.devDependencies;delete metadata.scripts
await writeFile(join(stage,'package.json'),JSON.stringify(metadata,null,2)+'\n')
if(windows)await run(process.env.ECHO_NSIS??'makensis',['desktop/windows-installer.nsi'])
else {
  await writeFile(join(stage,'echo'),'#!/bin/sh\nECHO_FILE=$(readlink -f -- "$0")\nECHO_ROOT=$(CDPATH= cd -- "$(dirname -- "$ECHO_FILE")" && pwd)\nif [ "$#" -eq 0 ]; then exec "$ECHO_ROOT/runtime/node" "$ECHO_ROOT/server/desktop.mjs" --open; fi\nexec "$ECHO_ROOT/runtime/node" "$ECHO_ROOT/server/cli.mjs" start "$@"\n')
  await writeFile(join(stage,'install.sh'),'#!/bin/sh\nECHO_FILE=$(readlink -f -- "$0")\nECHO_ROOT=$(CDPATH= cd -- "$(dirname -- "$ECHO_FILE")" && pwd)\nexec "$ECHO_ROOT/runtime/node" "$ECHO_ROOT/install-linux.mjs" "$@"\n')
  await writeFile(join(stage,'uninstall.sh'),'#!/bin/sh\nECHO_FILE=$(readlink -f -- "$0")\nECHO_ROOT=$(CDPATH= cd -- "$(dirname -- "$ECHO_FILE")" && pwd)\nexec "$ECHO_ROOT/runtime/node" "$ECHO_ROOT/install-linux.mjs" --uninstall --prefix "$ECHO_ROOT/../.."\n')
  await cp('desktop/install-linux.mjs',join(stage,'install-linux.mjs'));await chmod(join(stage,'echo'),0o755);await chmod(join(stage,'install.sh'),0o755)
  await chmod(join(stage,'runtime/node'),0o755);await chmod(join(stage,'native/echo-host'),0o755)
  await chmod(join(stage,'uninstall.sh'),0o755)
  await run('tar',['-czf','release/Echo-'+metadata.version+'-linux-x64.tar.gz','-C',stage,'.'])
}
console.log('Desktop artifact built. Runtime, installation, tray, login and credential checks are required before public release.')
