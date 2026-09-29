import type { Attachment } from './archive'

export async function identifyMedia(file: File, hint: Attachment['kind']): Promise<'image' | 'audio' | 'video' | 'file'> {
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer())
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end))
  if ((bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (bytes[0] === 0x89 && ascii(1, 4) === 'PNG')
    || ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
    || (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')) return 'image'
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    || ascii(0, 4) === 'fLaC' || (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE')) return 'audio'
  if (ascii(0, 4) === 'OggS') return hint === 'video' ? 'video' : 'audio'
  if (ascii(4, 8) === 'ftyp') {
    if (/^(avif|avis|heic|heix|mif1)$/.test(ascii(8, 12))) return 'file'
    return hint === 'audio' ? 'audio' : 'video'
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return hint === 'audio' ? 'audio' : 'video'
  return 'file'
}
