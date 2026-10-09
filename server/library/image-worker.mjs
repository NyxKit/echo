import { parentPort, workerData } from 'node:worker_threads'
import sharp from 'sharp'
try {
  const bytes = Buffer.from(workerData.bytes)
  const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning', sequentialRead: true })
  const metadata = await image.metadata()
  if (!['png','jpeg','webp'].includes(metadata.format) || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000) throw new Error('unsupported')
  const result = await image.rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true })
  if (result.data.length > 4_400_000) throw new Error('image_limit')
  parentPort.postMessage({ image: { dataUrl: `data:image/png;base64,${result.data.toString('base64')}`, width: result.info.width, height: result.info.height } })
} catch { parentPort.postMessage({ error: 'library_image_unavailable' }) }
finally { parentPort.close() }
