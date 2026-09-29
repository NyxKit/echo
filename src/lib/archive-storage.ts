import { safePath } from './archive'

const databaseName = 'meta-chat-archive'
const stores = ['files', 'metadata']
const chunkSize = 4 * 1024 * 1024
interface StoredFile { path: string; name: string; modified: number; type: string; size: number; chunks: number }
interface Manifest { version: 2; id: string; count: number }

export class ArchiveStorageError extends Error {
  constructor(public readonly reason: 'unavailable' | 'invalid' | 'quota') {
    super(`Archive storage ${reason}`)
  }
}

function storageError(error: unknown): ArchiveStorageError {
  if (error instanceof ArchiveStorageError) return error
  return new ArchiveStorageError(error instanceof DOMException && error.name === 'QuotaExceededError' ? 'quota' : 'unavailable')
}

function openDatabase(signal?: AbortSignal): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      reject(error)
    }
    const abort = () => finish(signal?.reason)
    const timeout = setTimeout(() => finish(new ArchiveStorageError('unavailable')), 5000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    try {
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return }
        for (const name of stores) request.result.createObjectStore(name)
      }
      request.onblocked = () => finish(new ArchiveStorageError('unavailable'))
      request.onerror = () => finish(storageError(request.error))
      request.onsuccess = () => {
        const database = request.result
        if (settled) { database.close(); return }
        settled = true
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
        database.onversionchange = () => database.close()
        resolve(database)
      }
    } catch (error) { finish(storageError(error)) }
  })
}

async function transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => () => T, signal?: AbortSignal): Promise<T> {
  const database = await openDatabase(signal)
  try {
    signal?.throwIfAborted()
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(stores, mode)
      let result: () => T
      let failure: unknown
      const abort = () => { try { tx.abort() } catch { /* Already completed. */ } }
      const cleanup = () => signal?.removeEventListener('abort', abort)
      signal?.addEventListener('abort', abort, { once: true })
      tx.oncomplete = () => {
        cleanup()
        try { resolve(result()) } catch (error) { reject(storageError(error)) }
      }
      tx.onabort = () => {
        cleanup()
        reject(signal?.aborted ? signal.reason : storageError(failure ?? tx.error))
      }
      try { result = work(tx) }
      catch (error) { failure = error; abort() }
    })
  } finally { database.close() }
}

function snapshotRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, 0, -1], [id, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])
}

async function serializeWrites<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return navigator.locks ? await navigator.locks.request('meta-chat-archive-write', { signal }, work) : work()
}

export function saveArchive(files: File[], signal?: AbortSignal): Promise<void> {
  return serializeWrites(async () => {
    const id = crypto.randomUUID()
    const safeFiles = files.filter(file => safePath(file.webkitRelativePath || file.name))
    try {
      for (let index = 0; index < safeFiles.length; index++) {
        const file = safeFiles[index]
        const chunks = Math.ceil(file.size / chunkSize)
        for (let chunk = 0; chunk < chunks; chunk++) {
          signal?.throwIfAborted()
          // Materialize bytes: a stored File or slice may still refer to the
          // original filesystem file. Bound each allocation for large videos.
          const bytes = await file.slice(chunk * chunkSize, (chunk + 1) * chunkSize).arrayBuffer()
          await transaction('readwrite', tx => {
            tx.objectStore('files').put(new Blob([bytes]), [id, index, chunk])
            return () => undefined
          }, signal)
        }
        const item: StoredFile = {
          path: file.webkitRelativePath || file.name,
          name: file.name,
          modified: file.lastModified,
          type: file.type,
          size: file.size,
          chunks,
        }
        await transaction('readwrite', tx => {
          tx.objectStore('files').put(item, [id, index, -1])
          return () => undefined
        }, signal)
      }
      await transaction('readwrite', tx => {
        const metadata = tx.objectStore('metadata')
        const previous = metadata.get('archive')
        previous.onsuccess = () => {
          const old = previous.result as Manifest | undefined
          if (old?.version === 2) tx.objectStore('files').delete(snapshotRange(old.id))
        }
        // Readers see the previous complete snapshot until this commit.
        metadata.put({ version: 2, id, count: safeFiles.length } satisfies Manifest, 'archive')
        return () => undefined
      }, signal)
    } catch (error) {
      // Remove partial writes without disturbing the previous saved snapshot.
      try {
        await transaction('readwrite', tx => {
          tx.objectStore('files').delete(snapshotRange(id))
          return () => undefined
        })
      } catch { /* Forget archive can retry cleanup if storage is unavailable. */ }
      throw error
    }
  }, signal)
}

export function restoreArchive(signal?: AbortSignal): Promise<File[] | undefined> {
  return serializeWrites(() => transaction('readwrite', tx => {
    const manifest = tx.objectStore('metadata').get('archive')
    const count = tx.objectStore('files').count()
    let files: IDBRequest<unknown[]> | undefined
    let keys: IDBRequest<IDBValidKey[]> | undefined
    manifest.onsuccess = () => {
      const info = manifest.result as Manifest | undefined
      // A tab closed mid-save can leave unpublished chunks. With the write
      // lock held, none can belong to an active writer in another tab.
      if (navigator.locks && (!info || (info.version === 2 && typeof info.id === 'string'))) {
        const fileStore = tx.objectStore('files')
        if (!info) fileStore.clear()
        else {
          const range = snapshotRange(info.id)
          fileStore.delete(IDBKeyRange.upperBound(range.lower, true))
          fileStore.delete(IDBKeyRange.lowerBound(range.upper, true))
        }
      }
      if (info?.version === 2 && typeof info.id === 'string') {
        const range = snapshotRange(info.id)
        files = tx.objectStore('files').getAll(range)
        keys = tx.objectStore('files').getAllKeys(range)
      }
    }
    return () => {
      if (!manifest.result) {
        if (count.result && !navigator.locks) throw new ArchiveStorageError('invalid')
        return undefined
      }
      const info = manifest.result as Manifest | undefined
      if (info?.version !== 2 || !Number.isSafeInteger(info.count) || info.count < 1 || !files || !keys) throw new ArchiveStorageError('invalid')
      const metadata = new Map<number, StoredFile>()
      const blobs = new Map<number, Map<number, Blob>>()
      keys.result.forEach((key, index) => {
        if (!Array.isArray(key) || key.length !== 3 || key[0] !== info.id || typeof key[1] !== 'number' || !Number.isSafeInteger(key[1]) || key[1] < 0 || key[1] >= info.count
          || typeof key[2] !== 'number' || !Number.isSafeInteger(key[2]) || key[2] < -1) throw new ArchiveStorageError('invalid')
        const value = files!.result[index]
        if (key[2] === -1) metadata.set(key[1], value as StoredFile)
        else {
          if (!(value instanceof Blob)) throw new ArchiveStorageError('invalid')
          if (!blobs.has(key[1])) blobs.set(key[1], new Map())
          blobs.get(key[1])!.set(key[2], value)
        }
      })
      if (metadata.size !== info.count) throw new ArchiveStorageError('invalid')
      return Array.from({ length: info.count }, (_, index) => {
        const item = metadata.get(index)
        const parts = blobs.get(index) ?? new Map<number, Blob>()
        if (!item || typeof item.path !== 'string' || !safePath(item.path) || typeof item.name !== 'string' || !item.name || typeof item.type !== 'string'
          || !Number.isFinite(item.modified) || !Number.isSafeInteger(item.size) || item.size < 0
          || item.chunks !== Math.ceil(item.size / chunkSize) || parts.size !== item.chunks) throw new ArchiveStorageError('invalid')
        const chunks = Array.from({ length: item.chunks }, (_, chunk) => {
          const blob = parts.get(chunk)
          if (!blob || blob.size !== Math.min(chunkSize, item.size - chunk * chunkSize)) throw new ArchiveStorageError('invalid')
          return blob
        })
        const file = new File(chunks, item.name, { type: item.type, lastModified: item.modified })
        // File's directory-picker path is not reliably retained by structured cloning.
        Object.defineProperty(file, 'webkitRelativePath', { value: item.path })
        return file
      })
    }
  }, signal), signal)
}

export function forgetArchive(): Promise<void> {
  return serializeWrites(() => transaction('readwrite', tx => {
    for (const name of stores) tx.objectStore(name).clear()
    return () => undefined
  }))
}
