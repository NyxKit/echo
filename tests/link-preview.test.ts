import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetIndex, importArchive, type Message } from '../src/lib/archive'
import { clearLinkPreviews, fetchLinkPreview, loadLinkPreview, messageLinks, parseLinkMetadata, previewEntry, previewUrl } from '../src/lib/link-preview'

afterEach(() => vi.unstubAllGlobals())
const url = 'https://example.com/article'
const signal = () => new AbortController().signal
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })

describe('link previews', () => {
  it.each(['http://example.com', 'https://user:secret@example.com', 'https://127.0.0.1', 'https://2130706433', 'https://[::1]', 'https://192.168.1.1', 'https://host.local', 'https://localhost.', 'https://example.com:8443', 'file:///etc/passwd', 'data:text/html,x'])('rejects preview destination %s', value => {
    expect(previewUrl(value)).toBeUndefined()
  })
  it('resolves HTTPS images relative to the requested page', () => {
    expect(previewUrl('../cover.png', url)).toBe('https://example.com/cover.png')
  })
  it('parses OG entities, relative images and fallbacks without interpreting active content', () => {
    expect(parseLinkMetadata(`<html><head><title>Fallback</title><script>"<meta property='og:title' content='bad'>"</script><template><meta property='og:title' content='bad'></template><meta property="og:title" content="Tea &amp; cake"><meta property="og:title" content="Second"><meta name="description" content="A description"><meta property="og:image" content="/cover.png"><base href="https://elsewhere.com"></head><body><meta property="og:description" content="Ignored"><img src="https://elsewhere.com/tracker"></body></html>`, url)).toEqual({ title: 'Tea & cake', description: 'A description', image: 'https://example.com/cover.png' })
    expect(parseLinkMetadata('<title>Title only</title>', url).title).toBe('Title only')
    expect(parseLinkMetadata('<meta property="og:image" content="javascript:alert(1)">', url).image).toBeUndefined()
  })
  it('deduplicates shared links and text links', () => {
    expect(messageLinks({ link: url, text: `See ${url} and https://example.org/page.` } as Message)).toEqual([url, 'https://example.org/page'])
  })
  it('uses metadata and thumbnails only when explicitly associated with a shared link', async () => {
    const file = new File([JSON.stringify({ title: 'Synthetic', messages: [
      { share: { link: url, title: 'Export title', thumbnail: { uri: 'photos/cover.png' } }, photos: [{ uri: 'photos/unrelated.png' }] },
      { share: { link: url, thumbnail: 'https://example.com/tracker.png' } },
    ] })], 'messages.json')
    const messages = (await importArchive([file])).conversations[0].messages
    expect(messages[0].linkPreview).toMatchObject({ title: 'Export title', image: 'photos/cover.png' })
    expect(messages[1].linkPreview?.image).toBeUndefined()
  })
  it('omits credentials and referrers and does not follow redirects', async () => {
    const fetch = vi.fn().mockResolvedValue(html('<title>A title</title>'))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchLinkPreview(url, signal())).toMatchObject({ status: 'ready', title: 'A title' })
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', mode: 'cors', cache: 'no-store' }))
  })
  it('retains metadata if an image is blocked or masquerades as an image', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(html('<meta property="og:title" content="Safe text"><meta property="og:image" content="/image.png">')).mockResolvedValueOnce(new Response('<svg onload="alert(1)"></svg>', { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchLinkPreview(url, signal())).toEqual({ status: 'ready', title: 'Safe text', description: undefined, image: undefined })
  })
  it('rejects non-HTML and oversized responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json' } })).mockResolvedValueOnce(html('x'.repeat(512 * 1024 + 1))))
    expect(await fetchLinkPreview(url, signal())).toEqual({ status: 'unavailable' })
    await expect(fetchLinkPreview(url, signal())).rejects.toThrow('Preview too large')
  })
  it('caches requests across views and clears them when the archive is forgotten', async () => {
    const assets = new AssetIndex([])
    const fetch = vi.fn().mockResolvedValue(html('<title>Cached</title>'))
    vi.stubGlobal('fetch', fetch)
    const entry = previewEntry(assets, url)
    expect(fetch).not.toHaveBeenCalled()
    await Promise.all([loadLinkPreview(assets, url), loadLinkPreview(assets, url)])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(entry.state.value.title).toBe('Cached')
    clearLinkPreviews(assets)
    expect(entry.state.value).toEqual({ status: 'idle' })
    expect(previewEntry(assets, url)).not.toBe(entry)
  })
  it('uses an unavailable state for CORS/network failures without exposing errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const assets = new AssetIndex([])
    await loadLinkPreview(assets, url)
    expect(previewEntry(assets, url).state.value).toEqual({ status: 'unavailable' })
  })
})
