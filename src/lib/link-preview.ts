import { Parser } from 'htmlparser2'
import { shallowRef, type ShallowRef } from 'vue'
import type { AssetIndex, Message } from './archive'
import { safeLink } from './archive'
import { identifyMedia } from './media'

export interface LinkMetadata { title?: string; description?: string; image?: string }
export interface PreviewState { status: 'idle' | 'loading' | 'ready' | 'unavailable'; title?: string; description?: string; image?: Blob }

export function messageLinks(message: Message): string[] {
  const values = [message.link, ...(message.text.match(/https?:\/\/[^\s<>"']+/gi) ?? []).map(value => value.replace(/[.,!;:?)]+$/, ''))]
  return [...new Set(values.map(safeLink).filter((value): value is string => !!value))]
}

// These checks exclude obvious local destinations; browser CORS remains mandatory.
export function previewUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(value, base)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || value.length > 4096) return undefined
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!host.includes('.') || host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)
      || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) return undefined
    url.hash = ''
    return url.href
  } catch { return undefined }
}

export function parseLinkMetadata(html: string, pageUrl: string): LinkMetadata {
  const metadata = new Map<string, string>()
  let title = ''
  let inTitle = false
  let blocked = 0
  let finished = false
  // A string parser, never a DOM: untrusted tags cannot initiate network requests.
  const parser = new Parser({
    onopentag(name, attributes) {
      if (finished) return
      if (name === 'body') { finished = true; return }
      if (['script', 'style', 'template', 'noscript'].includes(name)) blocked++
      if (blocked) return
      if (name === 'title') inTitle = true
      if (name !== 'meta') return
      const key = (attributes.property || attributes.name || '').toLowerCase()
      const value = attributes.content?.trim()
      if (value && !metadata.has(key)) metadata.set(key, value.slice(0, 4096))
    },
    ontext(text) { if (inTitle && !blocked && !finished) title = (title + text).slice(0, 300) },
    onclosetag(name) {
      if (name === 'head') finished = true
      if (name === 'title') inTitle = false
      if (['script', 'style', 'template', 'noscript'].includes(name)) blocked = Math.max(0, blocked - 1)
    },
  }, { decodeEntities: true })
  parser.end(html)
  const image = metadata.get('og:image:secure_url') || metadata.get('og:image') || metadata.get('og:image:url') || metadata.get('twitter:image')
  return {
    title: (metadata.get('og:title') || metadata.get('twitter:title') || title).trim().slice(0, 300) || undefined,
    description: (metadata.get('og:description') || metadata.get('twitter:description') || metadata.get('description'))?.slice(0, 600),
    image: image ? previewUrl(image, pageUrl) : undefined,
  }
}

async function readResponse(response: Response, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel()
    throw new Error('Preview unavailable')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > maximum) throw new Error('Preview too large')
      chunks.push(value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

async function request(url: string, signal: AbortSignal): Promise<Response> {
  return fetch(url, { signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' })
}

export async function fetchLinkPreview(url: string, signal: AbortSignal): Promise<PreviewState> {
  const safe = previewUrl(url)
  if (!safe) return { status: 'unavailable' }
  const response = await request(safe, signal)
  if (!/^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel()
    return { status: 'unavailable' }
  }
  const bytes = await readResponse(response, 512 * 1024)
  const metadata = parseLinkMetadata(new TextDecoder().decode(bytes), safe)
  let image: Blob | undefined
  if (metadata.image) {
    try {
      const response = await request(metadata.image, signal)
      const type = (response.headers.get('content-type') ?? '').split(';')[0].toLowerCase()
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(type)) {
        await response.body?.cancel()
      } else {
        const bytes = await readResponse(response, 2 * 1024 * 1024)
        const file = new File([bytes], 'preview', { type })
        if (await identifyMedia(file, 'image') === 'image') {
          const bitmap = await createImageBitmap(file)
          if (bitmap.width <= 4096 && bitmap.height <= 4096 && bitmap.width * bitmap.height <= 16_000_000) image = file
          bitmap.close()
        }
      }
    } catch { /* Metadata remains useful when an image is blocked or invalid. */ }
  }
  return { status: metadata.title || metadata.description || image ? 'ready' : 'unavailable', title: metadata.title, description: metadata.description, image }
}

interface PreviewEntry { state: ShallowRef<PreviewState>; controller?: AbortController }
const caches = new WeakMap<AssetIndex, Map<string, PreviewEntry>>()

export function previewEntry(assets: AssetIndex, url: string): PreviewEntry {
  let cache = caches.get(assets)
  if (!cache) { cache = new Map(); caches.set(assets, cache) }
  let entry = cache.get(url)
  if (!entry) {
    entry = { state: shallowRef<PreviewState>({ status: 'idle' }) }
    cache.set(url, entry)
  }
  return entry
}

export async function loadLinkPreview(assets: AssetIndex, url: string): Promise<void> {
  const entry = previewEntry(assets, url)
  if (entry.state.value.status !== 'idle') return
  entry.state.value = { status: 'loading' }
  const controller = new AbortController()
  entry.controller = controller
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const result = await fetchLinkPreview(url, controller.signal)
    if (entry.controller === controller && entry.state.value.status === 'loading') {
      entry.state.value = result
      const images = [...(caches.get(assets)?.values() ?? [])].filter(item => item.state.value.image)
      for (const old of images.slice(0, Math.max(0, images.length - 16))) {
        old.state.value = { ...old.state.value, image: undefined }
      }
    }
  } catch { /* Do not expose destination URLs or server errors in logs/UI. */ }
  finally {
    clearTimeout(timeout)
    entry.controller = undefined
    if (entry.state.value.status === 'loading') entry.state.value = { status: 'unavailable' }
  }
}

export function clearLinkPreviews(assets: AssetIndex): void {
  const cache = caches.get(assets)
  cache?.forEach(entry => { entry.controller?.abort(); entry.state.value = { status: 'idle' } })
  cache?.clear()
  caches.delete(assets)
}
