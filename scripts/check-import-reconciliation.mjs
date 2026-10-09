import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLibrary } from '../server/library/client.mjs'
import { validateExport } from '../server/imports/validate.mjs'

// Many conversations sharing self exercise candidate discovery, unlike the
// single large conversation capacity check. Every value is generated here.
const root = await mkdtemp(join(tmpdir(), 'echo-synthetic-reconciliation-'))
const groups = 40, records = 500
let library
async function stage(extra) {
  const jobId = randomUUID(), directory = join(root, 'imports', jobId), files = []
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (let group = 0; group < groups; group++) {
    const source = JSON.stringify({ title: `Synthetic thread ${group}`, owner: { id: '1000001', name: 'Synthetic Self' },
      participants: [{ name: 'Synthetic Self' }, { name: `Synthetic peer ${group}` }],
      messages: Array.from({ length: records + extra }, (_, index) => ({ sender_name: 'Synthetic Self', timestamp_ms: index,
        content: `Synthetic record ${group}:${index}` })) })
    const id = randomUUID(); await writeFile(join(directory, id), source, { mode: 0o600 })
    files.push({ id, path: `messages/inbox/synthetic_${group}/message_1.json`, size: Buffer.byteLength(source) })
  }
  await validateExport(directory, files)
  return jobId
}
try {
  library = await openLibrary(root)
  const first = await library.commitImport({ jobId: await stage(0) })
  assert.equal(first.additions, groups * records)
  const jobId = await stage(1), started = performance.now()
  const review = await library.previewImport({ jobId })
  const checkingSeconds = (performance.now() - started) / 1000
  assert.equal(review.ready, true)
  assert.equal(review.conversations.length, groups)
  const updated = await library.commitImport({ jobId })
  assert.equal(updated.additions, groups); assert.equal(updated.matched, groups * records)
  assert.equal((await library.conversations()).length, groups)
  console.log(JSON.stringify({ syntheticConversations: groups, syntheticExistingMessages: groups * records,
    checkingSeconds: Number(checkingSeconds.toFixed(3)), result: 'incremental reconciliation preserved all history and added exactly one record per conversation' }))
} finally { await library?.close(); await rm(root, { recursive: true, force: true }) }
