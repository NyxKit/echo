import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { openLibrary } from '../server/library/client.mjs'
import { syntheticZip } from './helpers/synthetic-zip.mjs'
const cleanup = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const raw = JSON.stringify({ title: 'Synthetic thread', owner: { id: '123456', name: 'Synthetic Self' }, participants: [{ name: 'Synthetic Self' }], messages: [{ sender_name: 'Synthetic Self', content: 'Generated', timestamp_ms: 1 }] })
async function app() {
  const directory = await mkdtemp(join(tmpdir(), 'echo-synthetic-jobs-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let library = await openLibrary(directory)
  cleanup.push(() => library.close())
  return { directory, get library() { return library }, async reopen() { await library.close(); library = await openLibrary(directory) } }
}
async function upload(service, jobId, path, bytes) {
  const buffer = Buffer.from(bytes), file = await service.beginFile(jobId, { path, size: buffer.length })
  for (let offset = 0; offset < buffer.length; offset += 1024 * 1024) await service.chunk(jobId, file.id, offset, buffer.subarray(offset, offset + 1024 * 1024))
  await service.finishFile(jobId, file.id)
  return file
}
async function settled(service, id) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const job = service.status(id)
    if (['completed', 'failed', 'cancelled', 'review'].includes(job.state)) return job
    await delay(10)
  }
  throw new Error('Synthetic job did not settle')
}

describe('reconnectable server-owned import jobs', () => {
  it('honors cancellation between history checking and commit', async () => {
    const state = await app(), service = state.library.imports
    const preview = state.library.previewImport, cancelImport = state.library.cancelImport
    let checked, release, cancelled
    const checkingDone = new Promise(resolve => { checked = resolve })
    const gate = new Promise(resolve => { release = resolve })
    const cancellationSent = new Promise(resolve => { cancelled = resolve })
    state.library.previewImport = async input => {
      const result = await preview(input)
      checked(); await gate
      return result
    }
    state.library.cancelImport = () => { cancelImport(); cancelled() }
    const job = await service.create({ kind: 'folder' })
    try {
      await upload(service, job.id, 'messages/inbox/synthetic/message_1.json', raw)
      await service.accept(job.id)
      await checkingDone
      const cancellation = service.cancel(job.id)
      await cancellationSent
      release()
      expect((await cancellation).state).toBe('cancelled')
      expect((await state.library.status()).owner).toBeNull()
      await expect(state.library.conversations()).rejects.toThrow('library_owner_required')
    } finally { release() }
  })
  it('accepts ZIP input, finishes independently, removes input, and restores summary/history after restart', async () => {
    const state = await app(), service = state.library.imports
    const observed = [], report = service.reportProgress
    service.reportProgress = value => {
      report(value)
      const live = service.status(value.jobId)
      observed.push({ state: live.state, progress: live.progress })
    }
    const job = await service.create({ kind: 'zip' })
    await upload(service, job.id, 'synthetic.zip', syntheticZip([{ path: 'wrapped/messages/inbox/synthetic/message_1.json', bytes: raw }]))
    expect((await service.accept(job.id)).state).toBe('extracting')
    const result = await settled(service, job.id)
    expect(result.state).toBe('completed'); expect(result.summary.additions).toBe(1)
    expect(observed).toContainEqual({ state: 'validating', progress: { phase: 'matching', completed: 0, total: 1 } })
    expect(observed).toContainEqual({ state: 'committing', progress: { phase: 'committing', completed: 1, total: 1 } })
    expect(await readdir(join(state.directory, 'imports', job.id))).toEqual(['state.json'])
    await state.reopen()
    expect(state.library.imports.status(job.id).state).toBe('completed')
    expect(await state.library.conversations()).toHaveLength(1)
  })
  it('produces no duplicate history for equivalent folder and ZIP input with different wrapping directories', async () => {
    const state = await app(), service = state.library.imports
    const first = await service.create({ kind: 'folder' })
    await upload(service, first.id, 'folder/messages/inbox/synthetic/message_1.json', raw)
    await service.accept(first.id); expect((await settled(service, first.id)).state).toBe('completed')
    const next = await service.create({ kind: 'zip' })
    await upload(service, next.id, 'synthetic.zip', syntheticZip([{ path: 'different/messages/inbox/synthetic/message_1.json', bytes: raw }], { zip64: true }))
    await service.accept(next.id)
    expect((await settled(service, next.id)).summary.additions).toBe(0)
    expect(await state.library.conversations()).toHaveLength(1)
  })
  it('does not accept incomplete uploads, rejects out-of-order chunks, and cleans cancellation', async () => {
    const state = await app(), service = state.library.imports, job = await service.create({ kind: 'folder' })
    const file = await service.beginFile(job.id, { path: 'synthetic.json', size: 10 })
    await expect(service.create({ kind: 'folder' })).rejects.toThrow('import_busy')
    await expect(service.chunk(job.id, file.id, 1, Buffer.from('a'))).rejects.toThrow('import_incomplete')
    await expect(service.accept(job.id)).rejects.toThrow('import_incomplete')
    await expect(service.finishFile(job.id, file.id)).rejects.toThrow('import_incomplete')
    expect((await service.cancel(job.id)).state).toBe('cancelled')
    expect(await readdir(join(state.directory, 'imports', job.id))).toEqual(['state.json'])
    expect((await state.library.status()).owner).toBeNull()
  })
  it('retains an explicit review until a user decision, then commits without a second dispatch', async () => {
    const state = await app(), service = state.library.imports, job = await service.create({ kind: 'folder' })
    const noOwner = JSON.stringify({ title: 'Synthetic', participants: [{ name: 'Synthetic Self' }, { name: 'Synthetic Other' }], messages: [{ sender_name: 'Synthetic Self', content: 'Generated' }] })
    await upload(service, job.id, 'messages/inbox/synthetic/message_1.json', noOwner)
    await service.accept(job.id)
    const review = await settled(service, job.id)
    expect(review.state).toBe('review'); expect(review.review.owner.needsReview).toBe(true)
    expect((await state.library.status()).owner).toBeNull()
    await service.review(job.id, { ownerChoice: { label: 'Synthetic Self' } })
    expect((await settled(service, job.id)).state).toBe('completed')
    await expect(service.accept(job.id)).rejects.toThrow('import_incomplete')
  })
  it('recovers an interrupted transfer and preserves retry bookkeeping for cleanup failures', async () => {
    const state = await app(), id = randomUUID(), root = join(state.directory, 'imports', id), fileId = randomUUID()
    await mkdir(root, { mode: 0o700 })
    await writeFile(join(root, 'state.json'), JSON.stringify({ version: 1, id, state: 'transferring', kind: 'folder', bytes: 1, files: 1 }), { mode: 0o600 })
    await writeFile(join(root, fileId), 'synthetic', { mode: 0o600 })
    await writeFile(join(root, `${fileId}.json.tmp`), '{}', { mode: 0o600 })
    await state.reopen()
    expect(state.library.imports.status(id).state).toBe('interrupted')
    expect(await readdir(root)).toEqual(['state.json'])
  })
  it('handles extraction failure without changing the committed library', async () => {
    const state = await app(), service = state.library.imports, job = await service.create({ kind: 'zip' })
    await upload(service, job.id, 'synthetic.zip', Buffer.from('not a zip'))
    await service.accept(job.id)
    const failed = await settled(service, job.id)
    expect(failed.state).toBe('failed'); expect(failed.error).toBe('import_zip_invalid')
    expect((await state.library.status()).owner).toBeNull()
    expect(await readdir(join(state.directory, 'imports', job.id))).toEqual(['state.json'])
  })
})
