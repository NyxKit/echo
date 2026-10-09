import { crc32, deflateRawSync } from 'node:zlib'

// Entirely generated ZIP containers, including deliberately malformed records.
export function syntheticZip(entries, { zip64 = false, disk = 0 } = {}) {
  const local = [], central = []
  let offset = 0
  for (const item of entries) {
    const name = Buffer.from(item.path), bytes = Buffer.from(item.bytes ?? ''), method = item.method ?? 8
    const compressed = method === 8 ? deflateRawSync(bytes) : bytes
    const checksum = item.crc ?? crc32(bytes), flags = 0x800 | (item.encrypted ? 1 : 0)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6)
    header.writeUInt16LE(method, 8); header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26)
    local.push(header, name, compressed)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x031e, 4); directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 20)
    directory.writeUInt32LE(zip64 ? 0xffffffff : bytes.length, 24); directory.writeUInt16LE(name.length, 28)
    directory.writeUInt16LE(item.disk ?? 0, 34)
    directory.writeUInt32LE(((item.mode ?? (item.path.endsWith('/') ? 0o040700 : 0o100600)) << 16) >>> 0, 38)
    directory.writeUInt32LE(zip64 ? 0xffffffff : offset, 42)
    let extra = Buffer.alloc(0)
    if (zip64) {
      extra = Buffer.alloc(28); extra.writeUInt16LE(1); extra.writeUInt16LE(24, 2)
      extra.writeBigUInt64LE(BigInt(bytes.length), 4); extra.writeBigUInt64LE(BigInt(compressed.length), 12); extra.writeBigUInt64LE(BigInt(offset), 20)
      directory.writeUInt16LE(extra.length, 30)
    }
    central.push(directory, name, extra); offset += header.length + name.length + compressed.length
  }
  const centralBytes = Buffer.concat(central), end = Buffer.alloc(22), extension = []
  if (zip64) {
    const record = Buffer.alloc(56), locator = Buffer.alloc(20)
    record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14)
    record.writeUInt32LE(disk, 20); record.writeBigUInt64LE(BigInt(entries.length), 24); record.writeBigUInt64LE(BigInt(entries.length), 32)
    record.writeBigUInt64LE(BigInt(centralBytes.length), 40); record.writeBigUInt64LE(BigInt(offset), 48)
    locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset + centralBytes.length), 8); locator.writeUInt32LE(1, 16)
    extension.push(record, locator)
  }
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(disk, 6)
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8); end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10)
  end.writeUInt32LE(zip64 ? 0xffffffff : centralBytes.length, 12); end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16)
  return Buffer.concat([...local, centralBytes, ...extension, end])
}
