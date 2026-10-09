// yauzl validates sizes and central records, but does not expose every disk
// field. Check the multi-volume envelope before handing entries to it.
export async function zipEnvelope(file, size) {
  const invalid = () => { throw new Error('import_zip_invalid') }
  async function read(offset, length) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > size) invalid()
    const bytes = Buffer.alloc(length)
    if ((await file.read(bytes, 0, length, offset)).bytesRead !== length) invalid()
    return bytes
  }
  const length = Math.min(size, 65535 + 22 + 20), tail = await read(size - length, length)
  let end = -1
  for (let i = length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === length) { end = i; break }
  if (end < 0) invalid()
  let offset, count, centralSize
  const endPosition = size - length + end
  const u64 = (b, p) => { const n = b.readBigUInt64LE(p); if (n > BigInt(Number.MAX_SAFE_INTEGER)) invalid(); return Number(n) }
  if (end >= 20 && tail.readUInt32LE(end - 20) === 0x07064b50) {
    if (tail.readUInt32LE(end - 16) !== 0 || tail.readUInt32LE(end - 4) !== 1) invalid()
    const zip64 = await read(u64(tail, end - 12), 56)
    if (zip64.readUInt32LE(0) !== 0x06064b50 || zip64.readUInt32LE(16) !== 0 || zip64.readUInt32LE(20) !== 0 || u64(zip64, 24) !== u64(zip64, 32)) invalid()
    offset = u64(zip64, 48); count = u64(zip64, 32); centralSize = u64(zip64, 40)
  } else {
    if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0 || tail.readUInt16LE(end + 8) !== tail.readUInt16LE(end + 10)) invalid()
    offset = tail.readUInt32LE(end + 16); count = tail.readUInt16LE(end + 10); centralSize = tail.readUInt32LE(end + 12)
  }
  if (offset + centralSize > endPosition) invalid()
  let cursor = offset, seen = 0
  return {
    count,
    async entry() {
      const header = await read(cursor, 46)
      if (header.readUInt32LE(0) !== 0x02014b50 || header.readUInt16LE(34) !== 0) invalid()
      cursor += 46 + header.readUInt16LE(28) + header.readUInt16LE(30) + header.readUInt16LE(32)
      if (cursor > offset + centralSize || ++seen > count) invalid()
    },
    finish() { if (seen !== count || cursor !== offset + centralSize) invalid() },
  }
}
