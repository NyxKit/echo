import { readdir, unlink, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { privateDirectory, privateFile, syncDirectory } from './files.mjs'
export async function removeImportFiles(directory) {
  const root = join(directory, 'imports')
  privateDirectory(root)
  for (const name of await readdir(root)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) throw new Error('library_cleanup_required')
    const job = join(root,name); privateDirectory(job)
    for (const file of await readdir(job)) {
      if (!/^(?:[a-f0-9-]{36}(?:\.json(?:\.tmp)?)?|(?:state|plan)\.json(?:\.tmp)?)$/.test(file)) throw new Error('library_cleanup_required')
      const path = join(job,file); privateFile(path); await unlink(path)
    }
    await rmdir(job)
  }
  syncDirectory(root)
}
