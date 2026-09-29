import { afterEach, describe, expect, it, vi } from 'vitest'
import { gifUrl } from '../src/lib/archive'
import { fetchGif, isGif } from '../src/lib/remote-gif'

import { gifBytes } from './gif-fixture'

const url = 'https://media.giphy.com/media/Synthetic/giphy.gif'
afterEach(() => vi.unstubAllGlobals())

describe('GIF URL policy', () => {
  it('allows recognized CDN GIFs and normalizes Giphy share pages without fetching them', () => {
    expect(gifUrl(`${url}?tracking=discarded#fragment`)).toBe(url)
    expect(gifUrl('https://giphy.com/gifs/synthetic-title-Synthetic')).toBe(url)
    expect(gifUrl('https://media.tenor.com/Synthetic/tenor.gif')).toBe('https://media.tenor.com/Synthetic/tenor.gif')
  })
  it.each([
    'https://evil.test/a.gif', 'https://media.giphy.com.evil.test/a.gif',
    'https://evil.giphy.com/a.gif', 'https://127.0.0.1/a.gif',
    'http://media.giphy.com/a.gif', 'https://user:secret@media.giphy.com/a.gif',
    'https://media.giphy.com:8443/a.gif', 'https://media.tenor.com/a.html',
    'https://media.giphy.com/a.gif%2fnot-a-gif',
  ])('does not fetch an unapproved URL: %s', async candidate => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(gifUrl(candidate)).toBeUndefined()
    await expect(fetchGif(candidate, new AbortController().signal)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('downloaded GIF verification', () => {
  it('creates an image blob only for valid GIF bytes and requests without credentials or redirects', async () => {
    const fetcher = vi.fn(async () => new Response(gifBytes as BodyInit, { headers: { 'content-type': 'image/gif' } }))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    const blob = await fetchGif(url, signal)
    expect(blob.type).toBe('image/gif')
    expect(isGif(new Uint8Array(await blob.arrayBuffer()))).toBe(true)
    expect(fetcher).toHaveBeenCalledWith(url, { signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
  })
  it('rejects HTML even with a forged GIF content type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<script>alert(1)</script>', { headers: { 'content-type': 'image/gif' } })))
    await expect(fetchGif(url, new AbortController().signal)).rejects.toThrow('Invalid GIF')
  })
  it('rejects wrong content types, truncated files, and impossible dimensions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(gifBytes as BodyInit, { headers: { 'content-type': 'text/html' } })))
    await expect(fetchGif(url, new AbortController().signal)).rejects.toThrow('Not a GIF')
    expect(isGif(gifBytes.slice(0, -1))).toBe(false)
    expect(isGif(new Uint8Array([...gifBytes.slice(0, 13), 0x3b]))).toBe(false)
    const huge = gifBytes.slice()
    huge[6] = 255; huge[7] = 255
    expect(isGif(huge)).toBe(false)
  })
  it('rejects a redirect response even if returned by a custom fetch implementation', async () => {
    const response = new Response(gifBytes as BodyInit, { headers: { 'content-type': 'image/gif' } })
    Object.defineProperty(response, 'redirected', { value: true })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(fetchGif(url, new AbortController().signal)).rejects.toThrow('GIF unavailable')
  })
  it('limits announced and streamed file sizes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ignored', { headers: { 'content-type': 'image/gif', 'content-length': String(16 * 1024 * 1024) } })))
    await expect(fetchGif(url, new AbortController().signal)).rejects.toThrow('GIF too large')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(16 * 1024 * 1024), { headers: { 'content-type': 'image/gif' } })))
    await expect(fetchGif(url, new AbortController().signal)).rejects.toThrow('GIF too large')
  })
})
