import { parentPort, workerData } from 'node:worker_threads'
import { openCore } from './core.mjs'
import { importErrorCodes } from '../imports/limits.mjs'

const safeCodes = new Set(['library_schema_newer', 'library_invalid_database', 'library_migration_failed', 'library_permissions',
  'library_recovery_failed', 'library_owner_required', 'library_owner_mismatch', 'library_invalid_input', 'library_limit',
  'library_busy', 'library_not_found', 'library_upload_invalid', 'library_disk_full', 'library_asset_unavailable',
  'library_portability_invalid', 'library_context_too_large', 'library_draft_conflict', 'library_context_changed', 'library_ambiguous_source', 'library_reconciliation_required', ...importErrorCodes])
const safeError = error => safeCodes.has(error?.message) ? error.message : error?.code === 'ENOSPC' ? 'library_disk_full' : 'library_storage_failed'
let core
try {
  core = openCore(workerData.directory, { cancellation: new Int32Array(workerData.cancellation),
    importProgress: value => parentPort.postMessage({ importProgress: value }) })
  parentPort.postMessage({ id: 0, result: core.status() })
} catch (error) {
  parentPort.postMessage({ id: 0, error: safeError(error) })
  parentPort.close()
}
if (core) parentPort.on('message', ({ id, operation, input }) => {
  try {
    if (!Object.hasOwn(core, operation)) throw new Error('library_invalid_input')
    const result = core[operation](input)
    parentPort.postMessage({ id, result })
    if (operation === 'close') parentPort.close()
  } catch (error) { parentPort.postMessage({ id, error: safeError(error) }) }
})
