import { createHash, randomUUID } from 'node:crypto'
import { constants, openSync, closeSync, writeSync, readSync, fsyncSync, renameSync, unlinkSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { privateFile, syncDirectory } from './files.mjs'

export const CHUNK_BYTES = 1024 * 1024
export const ASSET_BYTES = 256 * CHUNK_BYTES
const reserve = 256 * CHUNK_BYTES

export function createMediaStore(directory, db, owner) {
  let upload
  const mediaPath = digest => join(directory, 'media', digest)
  function row(id) {
    const found = db.prepare('SELECT id, user_id AS userId, digest, size FROM assets WHERE user_id = ? AND id = ?').get(owner().userId, id)
    if (!found) throw new Error('library_not_found')
    return found
  }
  function active(id) {
    if (!upload || upload.id !== id || upload.userId !== owner().userId) throw new Error('library_upload_invalid')
    return upload
  }
  function available(bytes) {
    const space = statfsSync(directory, { bigint: true })
    if (space.bavail * space.bsize < BigInt(bytes + reserve)) throw new Error('library_disk_full')
  }
  function cancel() {
    if (!upload) return
    if (upload.fd !== undefined) { closeSync(upload.fd); upload.fd = undefined }
    unlinkSync(upload.path)
    upload = undefined
  }
  return {
    begin() {
      const userId = owner().userId
      if (upload) throw new Error('library_busy')
      available(0)
      const id = randomUUID()
      const path = join(directory, 'staging', `${id}.part`)
      upload = { id, userId, path, fd: openSync(path, 'wx', 0o600), hash: createHash('sha256'), size: 0 }
      return { id, userId }
    },
    append({ id, bytes }) {
      const entry = active(id)
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CHUNK_BYTES || entry.size + bytes.length > ASSET_BYTES) throw new Error('library_limit')
      available(bytes.length)
      let offset = 0
      try {
        while (offset < bytes.length) {
          const written = writeSync(entry.fd, bytes, offset, bytes.length - offset)
          if (!written) throw new Error('library_storage_failed')
          offset += written
        }
      } catch (error) { cancel(); throw error }
      entry.hash.update(bytes); entry.size += bytes.length
      return { size: entry.size }
    },
    finish({ id }) {
      const entry = active(id)
      fsyncSync(entry.fd); closeSync(entry.fd); entry.fd = undefined
      const digest = entry.hash.digest('hex')
      const destination = mediaPath(digest)
      const existing = privateFile(destination, true)
      if (existing) {
        // Reused bytes must still match the digest, not merely the filename.
        const hash = createHash('sha256')
        const fd = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const bytes = Buffer.alloc(CHUNK_BYTES)
          let size
          while ((size = readSync(fd, bytes)) > 0) hash.update(bytes.subarray(0, size))
        } finally { closeSync(fd) }
        if (existing.size !== entry.size || hash.digest('hex') !== digest) throw new Error('library_asset_unavailable')
        unlinkSync(entry.path)
      } else renameSync(entry.path, destination)
      upload = undefined
      syncDirectory(join(directory, 'media'))
      syncDirectory(join(directory, 'staging'))
      // The completed file is durable before its database reference exists.
      db.prepare('INSERT OR IGNORE INTO assets (id, user_id, digest, size) VALUES (?, ?, ?, ?)').run(randomUUID(), entry.userId, digest, entry.size)
      return db.prepare('SELECT id, user_id AS userId, size FROM assets WHERE user_id = ? AND digest = ?').get(entry.userId, digest)
    },
    cancel({ id }) { active(id); cancel(); return { cancelled: true } },
    metadata({ id }) { const value = row(id); return { id: value.id, userId: value.userId, size: value.size } },
    read({ id, offset = 0, length = CHUNK_BYTES }) {
      const value = row(id)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.size || !Number.isInteger(length) || length < 1 || length > CHUNK_BYTES) throw new Error('library_invalid_input')
      const path = mediaPath(value.digest)
      try {
        if (privateFile(path).size !== value.size) throw new Error('library_asset_unavailable')
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const bytes = Buffer.alloc(Math.min(length, value.size - offset))
          let read = 0
          while (read < bytes.length) {
            const count = readSync(fd, bytes, read, bytes.length - read, offset + read)
            if (!count) throw new Error('library_asset_unavailable')
            read += count
          }
          return { id: value.id, userId: value.userId, bytes }
        } finally { closeSync(fd) }
      } catch { throw new Error('library_asset_unavailable') }
    },
    close: cancel,
  }
}
