import { beforeEach, expect, it, vi } from 'vitest'
import { createSSRApp, onServerPrefetch } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { useLibraryStorage } from '../src/composables/useLibraryStorage'
import type { Archive } from '../src/lib/archive'

const api = vi.hoisted(() => ({ status: vi.fn(), conversations: vi.fn(), preferences: vi.fn(), messages: vi.fn(), position: vi.fn(), savePreference: vi.fn(), assetUrl: vi.fn() }))
vi.mock('../src/lib/library-api', () => ({ createLibraryApi: () => api, LibraryApiError: class extends Error {} }))

beforeEach(() => {
  vi.resetAllMocks()
  api.status.mockResolvedValue({ revision: 1, owner: { userId: 'synthetic-owner', label: 'Synthetic Self' } })
  api.conversations.mockResolvedValue({ items: [] })
  api.preferences.mockResolvedValue({ values: { activeConversation: 'synthetic-conversation' } })
})

async function refreshTwice() {
  const restore = vi.fn(), adopt = vi.fn().mockResolvedValue(undefined)
  // SSR invokes the real refresh logic without accessing a DOM, browser cache,
  // local library, or network. Lifecycle polling is intentionally not mounted.
  await renderToString(createSSRApp({ setup() {
    const storage = useLibraryStorage(true, adopt, vi.fn(), restore)
    onServerPrefetch(async () => { await storage.refresh(); await storage.refresh() })
    return () => null
  } }))
  return { restore, adopt }
}

it('restores the startup conversation once, without reopening it after an import refresh', async () => {
  const { restore, adopt } = await refreshTwice()
  expect(restore).toHaveBeenCalledExactlyOnceWith('synthetic-conversation')
  expect(adopt).toHaveBeenCalledTimes(2)
})

it('does not navigate away from an import when the initially empty library becomes populated', async () => {
  api.status.mockResolvedValueOnce({ revision: 0, owner: null })
  const { restore, adopt } = await refreshTwice()
  expect(restore).not.toHaveBeenCalled()
  expect(adopt).toHaveBeenCalledTimes(2)
})

it('binds every attachment to its fixed source slot, including missing assets and remote GIFs', async () => {
  const adopted: Archive[] = []
  api.conversations.mockResolvedValue({ items: [{ id: 'synthetic-conversation', title: 'Synthetic media', participants: ['Synthetic Self'], category: 'Inbox', pictures: [], messageCount: 1 }] })
  api.assetUrl.mockImplementation(id => `/api/library/v1/assets/${id}`)
  api.position.mockResolvedValue({ position: null })
  const remote = 'https://media.giphy.com/media/abc123/giphy.gif'
  api.messages.mockResolvedValue({ items: [{ id: 'synthetic-message', ordinal: 0, sourceAssets: [], versionCount: 1, assetConflictCount: 0,
    sourceJson: JSON.stringify({ sender_name: 'Synthetic Self', photos: [{ uri: 'one.png' }, { uri: 'two.png' }],
      audio_files: [{ uri: 'tone.wav' }], files: [{ uri: 'missing.txt' }], gifs: [{ uri: remote }, { uri: 'local.gif' }] }),
    attachments: [{ slot: 0, assetId: 'first' }, { slot: 1, assetId: 'second' }, { slot: 2, assetId: 'audio' },
      { slot: 3, assetId: null }, { slot: 4, assetId: null }, { slot: 5, assetId: 'last' }],
  }] })
  await renderToString(createSSRApp({ setup() {
    const storage = useLibraryStorage(true, async archive => { if (archive) adopted.push(archive) }, vi.fn(), vi.fn())
    onServerPrefetch(async () => { await storage.refresh(); await storage.loadConversation('synthetic-conversation'); expect(storage.error.value).toBe('') })
    return () => null
  } }))
  const archive = adopted[0]!, attachments = archive.conversations[0]!.messages[0]!.attachments
  expect(attachments.map(attachment => archive.assets.url(attachment.uri, ''))).toEqual([
    '/api/library/v1/assets/first', '/api/library/v1/assets/second', '/api/library/v1/assets/audio', undefined, undefined, '/api/library/v1/assets/last',
  ])
  expect(attachments[4]).toMatchObject({ uri: remote, remote: true })
})
