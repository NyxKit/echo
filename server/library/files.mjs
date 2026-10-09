import { windows, checkPrivate, ensureDirectory } from '../platform.mjs'
import { constants, lstatSync, mkdirSync, openSync, closeSync, readdirSync, unlinkSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'

export function privateDirectory(path) {
  try { ensureDirectory(path) } catch { throw new Error('library_permissions') }
}

export function privateFile(path, optional = false) {
  try {
    const info = lstatSync(path)
    try { checkPrivate(path, info) } catch { throw new Error('library_permissions') }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('library_permissions')
    return info
  } catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error }
}

export function syncDirectory(path) {
  // Windows does not expose a portable directory fsync through Node. File data
  // is flushed before rename; SQLite FULL handles its own commit durability.
  if (windows) return
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export function recoverFiles(directory, db) {
  // Staging is never referenced by committed rows. Installed bytes are retained
  // whenever any asset row refers to them, including unattached retained assets.
  for (const name of readdirSync(join(directory, 'staging'))) {
    if (!/^[a-f0-9-]{36}\.part$/.test(name)) throw new Error('library_recovery_failed')
    const path = join(directory, 'staging', name)
    privateFile(path)
    unlinkSync(path)
  }
  for (const name of readdirSync(join(directory, 'media'))) {
    if (!/^[a-f0-9]{64}$/.test(name)) throw new Error('library_recovery_failed')
    const path = join(directory, 'media', name)
    privateFile(path)
    if (!db.prepare('SELECT 1 FROM assets WHERE digest = ?').get(name)) unlinkSync(path)
  }
  syncDirectory(join(directory, 'staging'))
  syncDirectory(join(directory, 'media'))
}
