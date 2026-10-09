import { Worker } from 'node:worker_threads'
import { createHash, randomUUID } from 'node:crypto'
import { validateAnalysis } from '../../shared/analysis-policy.mjs'
function resize(bytes) {
  const worker = new Worker(new URL('./image-worker.mjs', import.meta.url), { workerData: { bytes }, stdout: true, stderr: true, execArgv: [] })
  worker.stdout.resume(); worker.stderr.resume()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { void worker.terminate(); reject(new Error('library_image_unavailable')) }, 15_000)
    worker.on('message', value => { if (value.image) resolve(value.image); else reject(new Error('library_image_unavailable')) })
    worker.once('error', () => reject(new Error('library_image_unavailable')))
    worker.once('exit', () => { clearTimeout(timeout); reject(new Error('library_image_unavailable')) })
  })
}
export async function prepareContext(library, input) {
  const context = await library.contextInput(input), turn = context.turn
  let imageCount = context.history.reduce((sum,value) => sum + value.images.length,0)
  for (const attachment of context.attachments) {
    const exclude = reason => turn.excluded.push({ reference: attachment.reference, reason })
    if (attachment.remote) { exclude('Remote media is excluded. No linked resource is fetched for analysis.'); continue }
    if (attachment.kind !== 'image') { exclude('Audio, video and files are not supported for analysis.'); continue }
    if (!attachment.assetId) { exclude('Attachment is unavailable in the library.'); continue }
    if (attachment.animated) { exclude('Animated image analysis is not supported.'); continue }
    if (imageCount >= 8) throw new Error('library_image_limit')
    try {
      const { size } = await library.asset({ id: attachment.assetId })
      if (size > 15 * 1024 * 1024) throw new Error('library_image_unavailable')
      const chunks = []
      for (let offset=0;offset<size;offset+=1024*1024) chunks.push(Buffer.from((await library.readAsset({ id: attachment.assetId, offset, length: Math.min(1024*1024,size-offset) })).bytes))
      const bytes = Buffer.concat(chunks)
      // Do not let an image decoder interpret SVG, PDF or other active formats.
      if (!(bytes.subarray(0,8).toString('hex') === '89504e470d0a1a0a' || bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ||
          bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP')) throw new Error('library_image_unavailable')
      turn.images.push({ reference: attachment.reference, ...await resize(bytes) }); imageCount++
    } catch { exclude('Image could not be prepared within supported format, size, or dimension limits.') }
  }
  const payload = { requestId: randomUUID(), model: context.model, sourceVersion: context.sourceVersion, sourceParts: context.sourceParts,
    contextVersion: createHash('sha256').update(JSON.stringify(context.sourceParts)).digest('hex'), history: context.history, turn }
  try { return { payload: validateAnalysis(payload), referenceMap: context.referenceMap, revision: context.revision } }
  catch (error) { throw new Error(error.message === 'context_too_large' ? 'library_context_too_large' : 'library_invalid_input') }
}
