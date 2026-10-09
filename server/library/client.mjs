import { windows, windowsData } from '../platform.mjs'
import { removeImportFiles } from './delete-files.mjs'
import { createImportService } from '../imports/service.mjs'
import { Worker } from 'node:worker_threads'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { acquireServiceLock } from '../service-lock.mjs'
import { ensurePrivateDirectory } from '../runtime-state.mjs'

export function libraryDirectory(env = process.env) {
  if (windows) return join(windowsData(env), 'library')
  return join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), '.local', 'share'), 'echo')
}

export async function openLibrary(directory) {
  await ensurePrivateDirectory(directory)
  const lease = await acquireServiceLock(join(directory, 'library.lock'))
  let worker
  const cancellation = new SharedArrayBuffer(4)
  try {
    worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { directory, cancellation }, stdout: true, stderr: true,
      // This is a plain module worker. Do not inherit launcher eval/input-type
      // flags or debugger/loader arguments into a process handling private rows.
      execArgv: [],
      // Bound retained JS state while processing the documented conversation
      // limits; native SQLite/cache buffers remain outside this heap budget.
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    })
  }
  catch { await lease.close(); throw new Error('library_storage_failed') }
  // A worker diagnostic must never print database values or private paths.
  worker.stdout.resume(); worker.stderr.resume()
  const pending = new Map()
  let sequence = 0, closed = false, closing, deleting = false, cleanupRequired = false
  const ready = new Promise((resolve, reject) => pending.set(0, { resolve, reject }))
  function failAll() {
    closed = true
    for (const entry of pending.values()) entry.reject(new Error('library_worker_failed'))
    pending.clear()
  }
  worker.on('message', message => {
    if (message.importProgress) { imports?.reportProgress(message.importProgress); return }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error))
    else entry.resolve(message.result)
  })
  worker.on('error', failAll)
  worker.on('exit', failAll)
  try { await ready }
  catch (error) { await worker.terminate(); await lease.close(); throw error }

  function call(operation, input) {
    if (closed || closing && operation !== 'close' || !lease.held) return Promise.reject(new Error('library_closed'))
    if (pending.size >= 8) return Promise.reject(new Error('library_busy'))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try { worker.postMessage({ id, operation, input }) }
      catch { pending.delete(id); reject(new Error('library_invalid_input')) }
    })
  }
  const api = Object.fromEntries(['status', 'resolveOwner', 'importConversation', 'conversations', 'messages', 'source', 'savePosition', 'position',
    'exportDiscussions', 'importDiscussions', 'contextInput', 'discussions', 'discussion', 'saveDiscussion', 'deleteDiscussion', 'analysisTurn', 'acceptTurn', 'updateTurn', 'messageVersions', 'snapshot', 'preferences', 'savePreference', 'correctIdentity', 'previewImport', 'commitImport', 'importHistory', 'beginAsset', 'appendAsset', 'finishAsset', 'cancelAsset', 'asset', 'readAsset'].map(operation => [operation, input => deleting && !['status','commitImport','previewImport','importHistory'].includes(operation) || cleanupRequired && !['status','preferences'].includes(operation) ? Promise.reject(new Error('library_cleanup_required')) : call(operation, input)]))
  const library = {
    ...api,
    async deleteLibrary() {
      if (deleting || closing || closed) throw new Error('library_busy')
      deleting = true
      try {
        await imports.close()
        await call('eraseLibrary'); cleanupRequired = true
        await call('cleanLibraryFiles')
        await removeImportFiles(directory)
        imports = await createImportService({ directory, library }); library.imports = imports
        await call('finishLibraryDeletion'); cleanupRequired = false
        return { deleted: true, cleanupRequired: false }
      } catch { return { deleted: false, cleanupRequired: true } }
      finally { deleting = false }
    },
    cancelImport() { Atomics.store(new Int32Array(cancellation), 0, 1) },
    resetImportCancellation() { Atomics.store(new Int32Array(cancellation), 0, 0) },
    close() {
      if (!closing) {
        const completed = (async () => { await imports.close(); return call('close') })()
        closing = (async () => {
          let timeout
          try {
            await Promise.race([completed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('library_shutdown_timeout')), 4000) })])
          } finally {
            clearTimeout(timeout); closed = true
            await worker.terminate()
            await lease.close()
          }
        })()
      }
      return closing
    },
  }
  let imports
  try { cleanupRequired = (await api.status()).cleanupRequired; imports = await createImportService({ directory, library, suspended: cleanupRequired }) }
  catch (error) { await worker.terminate(); await lease.close(); throw error }
  library.imports = imports
  cleanupRequired = (await api.status()).cleanupRequired
  if (cleanupRequired) await imports.close()
  return library
}
