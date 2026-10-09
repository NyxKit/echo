import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { open, statfs, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32 } from 'node:zlib'
import yauzl from 'yauzl'
import { zipEnvelope } from './zip-envelope.mjs'
import { importLimits, pathRegistry } from './limits.mjs'

export async function checkSpace(directory, bytes, limits = importLimits) {
  const space = await statfs(directory, { bigint: true })
  if (space.bavail * space.bsize < BigInt(bytes + limits.reserve)) throw new Error('import_disk_full')
}

export async function extractZip(input, directory, { limits = importLimits, signal, progress = () => {} } = {}) {
  const inputSize = (await stat(input)).size
  if (inputSize > limits.input) throw new Error('import_limit')
  const envelopeFile = await open(input, 'r')
  let envelope
  try { envelope = await zipEnvelope(envelopeFile, inputSize) } catch (error) { await envelopeFile.close(); throw error }
  let zip
  try { zip = await yauzl.openPromise(input, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }) }
  catch { await envelopeFile.close(); throw new Error('import_zip_invalid') }
  const paths = pathRegistry(limits), files = []
  let total = 0, count = 0
  const deadline = Date.now() + limits.duration
  const timeout = setTimeout(() => zip.close(), limits.duration)
  const abort = () => zip.close()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    if (!Number.isSafeInteger(zip.entryCount) || zip.entryCount > limits.entries) throw new Error('import_limit')
    for await (const entry of zip.eachEntry()) {
      await envelope.entry()
      if (signal?.aborted) throw new Error('import_cancelled')
      if (Date.now() > deadline) throw new Error('import_timeout')
      const directoryEntry = entry.fileName.endsWith('/')
      const path = paths.add(directoryEntry ? entry.fileName.slice(0, -1) : entry.fileName, directoryEntry)
      const unixType = (entry.externalFileAttributes >>> 16) & 0o170000
      const dosAttributes = entry.externalFileAttributes & 0xff
      if (unixType && unixType !== (directoryEntry ? 0o040000 : 0o100000) || dosAttributes & 0x08 ||
          !directoryEntry && dosAttributes & 0x10) throw new Error('import_zip_special')
      if (entry.generalPurposeBitFlag & (1 | 0x40)) throw new Error('import_zip_encrypted')
      if (![0, 8].includes(entry.compressionMethod)) throw new Error('import_zip_method')
      if (!Number.isSafeInteger(entry.uncompressedSize) || !Number.isSafeInteger(entry.compressedSize) ||
          entry.uncompressedSize > limits.entry || total + entry.uncompressedSize > limits.expanded) throw new Error('import_limit')
      if (directoryEntry) {
        if (entry.uncompressedSize !== 0) throw new Error('import_zip_invalid')
        continue
      }
      await checkSpace(directory, entry.uncompressedSize, limits)
      const id = randomUUID(), destination = join(directory, id)
      let bytes = 0, checksum = 0
      const meter = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length; total += chunk.length
        if (signal?.aborted) { done(new Error('import_cancelled')); return }
        if (Date.now() > deadline) { done(new Error('import_timeout')); return }
        if (bytes > limits.entry || total > limits.expanded) { done(new Error('import_limit')); return }
        checksum = crc32(chunk, checksum)
        done(null, chunk)
      } })
      const source = await zip.openReadStreamPromise(entry)
      await pipeline(source, meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal })
      if (bytes !== entry.uncompressedSize || checksum !== entry.crc32) throw new Error('import_integrity')
      const handle = await open(destination, 'r+')
      try { await handle.sync() } finally { await handle.close() }
      files.push({ id, path, size: bytes })
      progress({ phase: 'extracting', completed: ++count, total: zip.entryCount, bytes: total })
    }
    if (signal?.aborted) throw new Error('import_cancelled')
    if (Date.now() > deadline) throw new Error('import_timeout')
    envelope.finish()
    return files
  } catch (error) {
    if (signal?.aborted) throw new Error('import_cancelled')
    if (Date.now() >= deadline) throw new Error('import_timeout')
    if (error.message?.startsWith('import_') || error.code === 'ENOSPC') throw error
    throw new Error('import_zip_invalid')
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); zip.close(); await envelopeFile.close() }
}
