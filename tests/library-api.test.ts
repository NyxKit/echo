import { describe, expect, it, vi } from 'vitest'
import { createLibraryApi, LibraryApiError, isLocalLibraryRuntime } from '../src/lib/library-api'

const conversation = '00000000-0000-4000-8000-000000000001'
const message = '00000000-0000-4000-8000-000000000002'

describe('typed browser library client', () => {
  it('uses same-origin credentials, no-store and the explicit request header without exposing a token', async () => {
    const request = vi.fn(async () => Response.json({ version: 1, items: [] }))
    const api = createLibraryApi(request)
    const controller = new AbortController()
    await api.messages(conversation, { after: 4, limit: 10 }, controller.signal)
    expect(request).toHaveBeenCalledWith(`/api/library/v1/conversations/${conversation}/messages?after=4&limit=10`, expect.objectContaining({
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { 'X-Echo-Request': '1' }, body: undefined,
    }))
  })

  it('does not retry mutations or expose raw server diagnostics', async () => {
    const request = vi.fn(async () => Response.json({ error: 'synthetic private diagnostic' }, { status: 500 }))
    const api = createLibraryApi(request)
    await expect(api.savePosition(conversation, { messageId: message, offset: 12 })).rejects.toEqual(new LibraryApiError('unavailable'))
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]).toEqual([`/api/library/v1/conversations/${conversation}/position`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ messageId: message, offset: 12 }),
      headers: { 'X-Echo-Request': '1', 'Content-Type': 'application/json' },
    })])
  })

  it('distinguishes a lost session, network failure and an incompatible response', async () => {
    await expect(createLibraryApi(async () => new Response('', { status: 401 })).status()).rejects.toEqual(new LibraryApiError('session_required'))
    await expect(createLibraryApi(async () => { throw new Error('synthetic detail') }).status()).rejects.toEqual(new LibraryApiError('unavailable'))
    await expect(createLibraryApi(async () => Response.json({ version: 2 })).status()).rejects.toEqual(new LibraryApiError('request_failed'))
  })

  it('creates only opaque asset URLs and rejects path or query injection', () => {
    const api = createLibraryApi()
    expect(api.assetUrl(message)).toBe(`/api/library/v1/assets/${message}`)
    expect(() => api.assetUrl('../synthetic')).toThrow('request_failed')
    expect(() => api.source(`${message}?userId=synthetic`)).toThrow('request_failed')
    expect(isLocalLibraryRuntime()).toBe(false)
  })
})
