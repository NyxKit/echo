import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ensurePrivateDirectory } from '../runtime-state.mjs'
import { privateDirectory, privateFile, syncDirectory } from '../library/files.mjs'
import { checkSpace } from './extract.mjs'
import { importLimits, logicalPath, pathRegistry, safeImportError } from './limits.mjs'
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const terminal = new Set(['completed', 'cancelled', 'failed', 'interrupted'])

export async function createImportService({ directory, library, limits = importLimits, suspended = false }) {
  const root = join(directory, 'imports')
  await ensurePrivateDirectory(root)
  const jobs = new Map(), manifests = new Map()
  let active, worker, running, closed = suspended, mutation = false
  let mutationDone = Promise.resolve()
  const path = id => join(root, id)
  async function atomic(file, value) {
    const temp = file + '.tmp'
    privateFile(file, true); privateFile(temp, true)
    const handle = await open(temp, 'w', 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    await rename(temp, file); syncDirectory(dirname(file))
  }
  let writing = Promise.resolve()
  function save(job) {
    const snapshot = structuredClone(job)
    writing = writing.catch(() => {}).then(() => atomic(join(path(job.id), 'state.json'), snapshot))
    return writing
  }
  async function clean(job) {
    let failed = false
    for (const name of await readdir(path(job.id))) {
      if (['state.json', 'state.json.tmp'].includes(name)) continue
      if (!/^(?:[a-f0-9-]{36}(?:\.json(?:\.tmp)?)?|plan\.json)$/.test(name)) { failed = true; continue }
      try { const file = join(path(job.id), name); privateFile(file); await unlink(file) } catch { failed = true }
    }
    job.cleanupRequired = failed
    manifests.delete(job.id)
    await save(job)
    if (failed) throw new Error('import_cleanup')
  }
  for (const name of suspended ? [] : await readdir(root)) {
    if (!uuid(name)) throw new Error('import_cleanup')
    privateDirectory(path(name))
    const stateFile = join(path(name), 'state.json')
    if (!privateFile(stateFile, true)) {
      // An interrupted create cannot have accepted work; retain a cleanup record.
      const abandoned = { version: 1, id: name, state: 'interrupted', error: 'import_interrupted', bytes: 0, files: 0 }
      jobs.set(name, abandoned); await clean(abandoned); continue
    }
    if (privateFile(stateFile).size > 16 * 1024 * 1024) throw new Error('import_invalid')
    const job = JSON.parse(await readFile(stateFile, 'utf8'))
    if (job.id !== name || job.version !== 1) throw new Error('import_invalid')
    jobs.set(name, job)
    if (!terminal.has(job.state)) {
      const committed = (await library.importHistory()).find(item => item.id === job.id)
      if (committed) { job.state = 'completed'; job.summary = committed; job.userId = committed.userId }
      else { job.state = 'interrupted'; job.error = 'import_interrupted' }
    }
    try { await clean(job) } catch { /* The status retains retryable cleanup. */ }
  }
  function get(id) {
    if (!uuid(id) || !jobs.has(id)) throw new Error('library_not_found')
    return jobs.get(id)
  }
  function transferable(id) {
    const job = get(id)
    if (closed || job.state !== 'transferring' || active !== id) throw new Error('import_incomplete')
    return job
  }
  function view(job) { return structuredClone(job) }
  function reportProgress({ jobId, ...value }) {
    const job = jobs.get(jobId)
    if (!job || active !== jobId || terminal.has(job.state) || job.state === 'review') return
    if (!['extracting', 'validating', 'matching', 'committing'].includes(value.phase)) return
    job.progress = value
    job.state = value.phase === 'matching' ? 'validating' : value.phase
    // Counters are live UI state. Durable phase boundaries and terminal state
    // are saved separately; fsync per progress event delays real import work.
  }
  async function exclusive(fn) {
    if (mutation) throw new Error('import_busy')
    mutation = true
    let release
    mutationDone = new Promise(resolve => { release = resolve })
    try { return await fn() } finally { mutation = false; release() }
  }
  async function finish(job, state, error) {
    const completed = { ...job, state }
    if (error) completed.error = error
    delete completed.review
    try { await clean(completed) } catch { completed.cleanupRequired = true; await save(completed) }
    Object.assign(job, completed); delete job.review
    if (active === job.id) active = undefined
  }
  async function commit(job, choices = {}) {
    if (job.cancelRequested || closed) throw new Error('import_cancelled')
    job.state = 'committing'; delete job.review; delete job.progress; await save(job)
    try {
      const result = await library.commitImport({ jobId: job.id, ...choices })
      job.summary = result; job.userId = result.userId
      await finish(job, 'completed')
    } catch (error) { await finish(job, error.message === 'import_cancelled' ? 'cancelled' : 'failed', safeImportError(error)) }
  }
  async function inspect(job, choices = {}) {
    const previous = job.choices ?? {}
    choices = { ...previous, ...choices, conversations: { ...previous.conversations, ...choices.conversations }, messages: { ...previous.messages, ...choices.messages } }
    job.choices = choices
    const review = await library.previewImport({ jobId: job.id, ...choices })
    if (job.cancelRequested || closed) throw new Error('import_cancelled')
    if (review.ready) await commit(job, choices)
    else { job.state = 'review'; job.review = review; await save(job) }
  }
  async function process(job, manifest) {
    try {
      const task = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { directory: path(job.id), kind: job.kind, manifest }, stdout: true, stderr: true, execArgv: [] })
      task.stdout.resume(); task.stderr.resume(); worker = task
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => { reject(new Error('import_timeout')); void task.terminate() }, limits.duration)
        task.once('exit', () => clearTimeout(deadline))
        task.on('message', message => {
          if (message.progress) reportProgress({ jobId: job.id, ...message.progress })
          if (message.error) reject(new Error(message.error))
          if (message.result) resolve(message.result)
        })
        task.once('error', () => reject(new Error('import_storage')))
        task.once('exit', () => reject(new Error(job.cancelRequested ? 'import_cancelled' : 'import_storage')))
      })
      await task.terminate(); if (worker === task) worker = undefined
      if (job.cancelRequested || closed) throw new Error('import_cancelled')
      job.state = 'validating'; delete job.progress; await save(job)
      await inspect(job)
    } catch (error) {
      if (worker) { await worker.terminate(); worker = undefined }
      await finish(job, job.cancelRequested || closed ? 'cancelled' : 'failed', safeImportError(error))
    }
  }
  return {
    reportProgress,
    list() { return [...jobs.values()].slice(-100).reverse().map(view) },
    status(id) { return view(get(id)) },
    async create({ kind }) {
      return exclusive(async () => {
        if (closed || active || [...jobs.values()].some(job => job.cleanupRequired)) throw new Error('import_busy')
        if (!['zip', 'folder'].includes(kind)) throw new Error('import_invalid')
        await checkSpace(root, 0, limits)
        const id = randomUUID(), job = { version: 1, id, kind, state: 'transferring', bytes: 0, files: 0, cleanupRequired: false }
        await mkdir(path(id), { mode: 0o700 }); syncDirectory(root); jobs.set(id, job); active = id
        manifests.set(id, { files: [], paths: pathRegistry(limits) })
        await save(job); return view(job)
      })
    },
    async beginFile(id, { path: logical, size }) {
      return exclusive(async () => {
        const job = transferable(id), manifest = manifests.get(id)
        if (!Number.isSafeInteger(size) || size < 0 || size > (job.kind === 'zip' ? limits.input : limits.entry) ||
            job.bytes + size > (job.kind === 'zip' ? limits.input : limits.expanded) || manifest.files.length >= limits.entries ||
            job.kind === 'zip' && manifest.files.length) throw new Error('import_limit')
        await checkSpace(root, size, limits)
        logicalPath(logical, limits)
        const file = { id: randomUUID(), path: manifest.paths.add(logical), size, received: 0, complete: false }
        const handle = await open(join(path(id), file.id), 'wx', 0o600); await handle.close()
        manifest.files.push(file)
        await atomic(join(path(id), `${file.id}.json`), file)
        job.files = manifest.files.length; job.bytes += size; await save(job)
        return { version: 1, id: file.id }
      })
    },
    async chunk(id, fileId, offset, bytes) {
      return exclusive(async () => {
        transferable(id)
        const file = manifests.get(id).files.find(item => item.id === fileId)
        if (!file || file.complete || file.received !== offset || !(bytes instanceof Uint8Array) || !bytes.length ||
          bytes.length > limits.chunk || file.received + bytes.length > file.size) throw new Error('import_incomplete')
        await checkSpace(root, bytes.length, limits)
        const handle = await open(join(path(id), file.id), 'r+')
        try {
          let written = 0
          while (written < bytes.length) { const result = await handle.write(bytes, written, bytes.length - written, offset + written); if (!result.bytesWritten) throw new Error('import_storage'); written += result.bytesWritten }
        } finally { await handle.close() }
        file.received += bytes.length
        return { version: 1, received: file.received }
      })
    },
    async finishFile(id, fileId) {
      return exclusive(async () => {
        transferable(id)
        const file = manifests.get(id).files.find(item => item.id === fileId)
        if (!file || file.received !== file.size) throw new Error('import_incomplete')
        const handle = await open(join(path(id), file.id), 'r+')
        try { await handle.sync() } finally { await handle.close() }
        file.complete = true; await atomic(join(path(id), `${file.id}.json`), file)
        return { version: 1, complete: true }
      })
    },
    async accept(id) {
      return exclusive(async () => {
        const job = transferable(id), manifest = manifests.get(id)
        if (!manifest.files.length || manifest.files.some(file => !file.complete)) throw new Error('import_incomplete')
        library.resetImportCancellation()
        job.state = job.kind === 'zip' ? 'extracting' : 'validating'; await save(job)
        running = process(job, manifest.files)
        // The accepted operation belongs to the service, not its HTTP connection.
        void running.catch(() => { job.state = 'failed'; job.error = 'import_storage' })
        return view(job)
      })
    },
    async review(id, choices) {
      return exclusive(async () => {
        const job = get(id)
        if (closed || job.state !== 'review' || active !== id) throw new Error('import_incomplete')
        library.resetImportCancellation()
        job.state = 'validating'; delete job.progress; await save(job)
        running = inspect(job, choices).catch(async error => {
          if (job.cancelRequested || closed || error.message === 'import_cancelled') {
            await finish(job, 'cancelled', 'import_cancelled')
          } else if (['import_owner_review', 'library_reconciliation_required', 'library_invalid_input'].includes(error.message)) {
            job.state = 'review'; job.review = await library.previewImport({ jobId: job.id }); job.error = 'import_invalid'; await save(job)
          } else await finish(job, 'failed', safeImportError(error))
        })
        void running.catch(() => { job.state = 'failed'; job.error = 'import_storage' })
        return view(job)
      })
    },
    async cancel(id) {
      await mutationDone
      const job = get(id)
      if (terminal.has(job.state)) return view(job)
      job.cancelRequested = true; library.cancelImport()
      if (worker) { worker.postMessage('cancel'); await worker.terminate(); worker = undefined }
      if (running && !['transferring', 'review'].includes(job.state)) await running
      else await exclusive(() => finish(job, 'cancelled', 'import_cancelled'))
      return view(job)
    },
    async retryCleanup(id) {
      const job = get(id)
      if (!terminal.has(job.state)) throw new Error('import_busy')
      await clean(job); return view(job)
    },
    async close() {
      closed = true
      await mutationDone
      if (active) {
        const job = get(active); job.cancelRequested = true; library.cancelImport()
        if (worker) { await worker.terminate(); worker = undefined }
        if (running && !['transferring', 'review'].includes(job.state)) await running
        else await finish(job, 'interrupted', 'import_interrupted')
      }
      await writing
    },
  }
}
