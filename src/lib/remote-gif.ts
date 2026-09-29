import { gifUrl } from './archive'

const maximumBytes = 15 * 1024 * 1024

export function isGif(bytes: Uint8Array): boolean {
  const header = String.fromCharCode(...bytes.subarray(0, 6))
  if (!['GIF87a', 'GIF89a'].includes(header) || bytes.length < 14) return false
  const width = bytes[6] | bytes[7] << 8
  const height = bytes[8] | bytes[9] << 8
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16_000_000) return false
  let offset = 13 + (bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0)
  let frames = 0
  const skipBlocks = () => {
    while (offset < bytes.length) {
      const size = bytes[offset++]
      if (size === 0) return true
      offset += size
    }
    return false
  }
  while (offset < bytes.length) {
    const marker = bytes[offset++]
    if (marker === 0x3b) return frames > 0 && offset === bytes.length
    if (marker === 0x21) {
      offset++ // Extension label; its payload is a sequence of length-prefixed blocks.
      if (!skipBlocks()) return false
    } else if (marker === 0x2c) {
      if (offset + 9 >= bytes.length || ++frames > 1000) return false
      const left = bytes[offset] | bytes[offset + 1] << 8
      const top = bytes[offset + 2] | bytes[offset + 3] << 8
      const frameWidth = bytes[offset + 4] | bytes[offset + 5] << 8
      const frameHeight = bytes[offset + 6] | bytes[offset + 7] << 8
      if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) return false
      const packed = bytes[offset + 8]
      offset += 9 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0)
      const codeSize = bytes[offset++]
      if (codeSize < 2 || codeSize > 8 || !bytes[offset] || !skipBlocks()) return false
    } else return false
  }
  return false
}

export async function fetchGif(uri: string, signal: AbortSignal): Promise<Blob> {
  const url = gifUrl(uri)
  if (!url) throw new Error('Unsupported GIF source')
  const response = await fetch(url, { signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
  if (!response.ok || response.redirected || response.type === 'opaque' || !response.body) {
    await response.body?.cancel()
    throw new Error('GIF unavailable')
  }
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (type !== 'image/gif') { await response.body.cancel(); throw new Error('Not a GIF') }
  if (Number(response.headers.get('content-length')) > maximumBytes) { await response.body.cancel(); throw new Error('GIF too large') }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maximumBytes) throw new Error('GIF too large')
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    if (!isGif(bytes)) throw new Error('Invalid GIF')
    return new Blob([bytes], { type: 'image/gif' })
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
