import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desktopEntry, desktopArgument, autostartPath, loginEnabled, setLoginEnabled } from '../server/autostart.mjs'
const roots=[]
afterEach(async()=>{for(const path of roots.splice(0))await rm(path,{recursive:true,force:true})})
it('defaults off and changes only an explicitly enabled synthetic login entry',async()=>{
  const root=await mkdtemp(join(tmpdir(),'echo-synthetic-login-'));roots.push(root)
  const env={XDG_CONFIG_HOME:root}
  expect(await loginEnabled({env})).toBe(false)
  await setLoginEnabled(true,{env})
  expect(await loginEnabled({env})).toBe(true)
  expect(await readFile(autostartPath(env),'utf8')).toBe(desktopEntry())
  expect(desktopEntry()).toContain('--login')
  await setLoginEnabled(false,{env})
  expect(await loginEnabled({env})).toBe(false)
  await writeFile(autostartPath(env),'Unrelated synthetic file')
  await expect(setLoginEnabled(true,{env})).rejects.toThrow('autostart_unavailable')
  expect(await readFile(autostartPath(env),'utf8')).toBe('Unrelated synthetic file')
})
it('escapes desktop-entry arguments and rejects multiline injection',()=>{
  expect(desktopArgument('/synthetic path/app%name')).toBe('"/synthetic path/app%%name"')
  expect(()=>desktopArgument('/synthetic\nHidden=true')).toThrow('autostart_unavailable')
  expect(desktopEntry('/synthetic/node','/synthetic/app')).toContain('Exec="/synthetic/node" "/synthetic/app" --login')
})
