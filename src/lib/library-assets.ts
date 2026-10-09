import { AssetIndex } from './archive'
import { createLibraryApi } from './library-api'

export class LibraryAssetIndex extends AssetIndex {
  private urls = new Map<string, string>()
  constructor() { super([]) }
  register(assetId: string): string {
    const uri = `library/${assetId}`
    this.urls.set(uri, createLibraryApi().assetUrl(assetId))
    return uri
  }
  override url(uri: string): string | undefined { return this.urls.get(uri) }
  override async read(uri: string, _directory: string, limit = 15 * 1024 * 1024): Promise<File | undefined> {
    const url = this.url(uri)
    if (!url) return undefined
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'X-Echo-Request': '1' }, signal: AbortSignal.timeout(15_000) })
    if (!response.ok || !response.body || Number(response.headers.get('Content-Length')) > limit) { await response.body?.cancel(); throw new Error('Attachment unavailable or too large.') }
    const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        size += item.value.length
        if (size > limit) throw new Error('Attachment exceeds the local processing limit.')
        chunks.push(new Uint8Array(item.value))
      }
    } finally { await reader.cancel() }
    return new File(chunks, 'Library attachment', { type: response.headers.get('Content-Type') ?? '' })
  }
}
