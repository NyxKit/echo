import { parentPort, workerData } from 'node:worker_threads'
import { join } from 'node:path'
import { extractZip } from './extract.mjs'
import { validateExport } from './validate.mjs'
import { safeImportError } from './limits.mjs'
const controller = new AbortController()
parentPort.on('message', message => { if (message === 'cancel') controller.abort() })
const progress = value => parentPort.postMessage({ progress: value })
try {
  const { directory, manifest, kind } = workerData
  const files = kind === 'zip' ? await extractZip(join(directory, manifest[0].id), directory, { signal: controller.signal, progress }) : manifest
  const result = await validateExport(directory, files, { signal: controller.signal, progress })
  parentPort.postMessage({ result })
} catch (error) { parentPort.postMessage({ error: safeImportError(error) }) }
finally { parentPort.close() }
