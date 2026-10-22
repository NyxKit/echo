import { afterEach, expect, it, vi } from 'vitest'
import { clearContextDrafts, contextDraft, editContextDraft, flushContextDraft, flushContextForSend, loadContextDraft, resolveContextConflict, retryContextDraft } from '../src/stores/conversation-context'
import { LibraryApiError } from '../src/lib/library-api'
import type { LibraryConversationContext } from '../shared/library-types'
const api = vi.hoisted(() => ({ conversationContext: vi.fn(), saveConversationContext: vi.fn() }))
vi.mock('../src/lib/library-api', () => ({ createLibraryApi: () => api, LibraryApiError: class extends Error { constructor(public code: string) { super(code) } } }))
const one = crypto.randomUUID(), two = crypto.randomUUID(), group = crypto.randomUUID(), userId = crypto.randomUUID()
const saved = (conversationId: string, markdown = '', revision = 0): LibraryConversationContext => ({ userId, conversationId, markdown, revision, inherited: [], relatedConversationIds: [], inheritance: 'none' })
afterEach(() => { clearContextDrafts(); vi.resetAllMocks(); vi.useRealTimers() })

it('blocks editing during load and keeps delayed responses bound to the right conversation', async () => {
  let release!: (value: LibraryConversationContext) => void
  api.conversationContext.mockImplementation((id: string) => id === one ? new Promise(resolve => { release = resolve }) : Promise.resolve(saved(two, 'Synthetic second', 1)))
  const loading = loadContextDraft(one)
  editContextDraft(one, 'Must not overwrite an unresolved load')
  expect(contextDraft(one).draft).toBe('')
  await loadContextDraft(two)
  editContextDraft(two, 'Edited second')
  release(saved(one, 'Synthetic first', 1)); await loading
  expect(contextDraft(two).draft).toBe('Edited second'); expect(contextDraft(one).draft).toBe('Synthetic first')
  expect(api.saveConversationContext).not.toHaveBeenCalled()
})

it('serializes a delayed save and a newer edit without losing text or mixing conversations', async () => {
  api.conversationContext.mockImplementation((id: string) => Promise.resolve(saved(id)))
  await loadContextDraft(one); await loadContextDraft(two)
  let release!: (value: LibraryConversationContext) => void
  api.saveConversationContext.mockReturnValueOnce(new Promise(resolve => { release = resolve })).mockImplementation(async (id, value) => saved(id, value.markdown, value.revision + 1))
  editContextDraft(one, 'First draft')
  const saving = flushContextDraft(one)
  await vi.waitFor(() => expect(api.saveConversationContext).toHaveBeenCalledOnce())
  editContextDraft(one, 'Latest draft'); editContextDraft(two, 'Independent draft')
  release(saved(one, 'First draft', 1)); await saving
  expect(api.saveConversationContext.mock.calls.map(([id, value]) => [id, value.markdown, value.revision])).toEqual([[one, 'First draft', 0], [one, 'Latest draft', 1]])
  expect(contextDraft(two).draft).toBe('Independent draft')
})

it('preserves failed and conflicting drafts, blocks Send and requires explicit conflict recovery', async () => {
  api.conversationContext.mockResolvedValue(saved(one))
  await loadContextDraft(one); editContextDraft(one, 'Local draft')
  api.saveConversationContext.mockRejectedValueOnce(new Error('Synthetic transport failure'))
  await expect(flushContextDraft(one)).rejects.toThrow('could not be saved')
  expect(contextDraft(one).draft).toBe('Local draft')
  await expect(flushContextForSend(one)).rejects.toThrow('could not be saved')
  api.conversationContext.mockResolvedValue(saved(one, 'Other tab version', 1))
  api.saveConversationContext.mockRejectedValueOnce(new LibraryApiError('library_note_conflict'))
  await expect(retryContextDraft(one)).rejects.toThrow('another tab')
  expect(contextDraft(one).conflict?.markdown).toBe('Other tab version')
  expect(contextDraft(one).draft).toBe('Local draft')
  api.saveConversationContext.mockResolvedValue(saved(one, 'Local draft', 2))
  await resolveContextConflict(one, true)
  expect(api.saveConversationContext).toHaveBeenLastCalledWith(one, { markdown: 'Local draft', revision: 1 })
  expect(contextDraft(one).error).toBe('')
})

it('flushes a pending individual draft for a group even when the saved note is empty', async () => {
  api.conversationContext.mockImplementation(async (id: string) => ({ ...saved(id), ...(id === group ? { relatedConversationIds: [one] } : {}) }))
  api.saveConversationContext.mockImplementation(async (id, value) => saved(id, value.markdown, value.revision + 1))
  await loadContextDraft(one); editContextDraft(one, 'New individual context')
  await loadContextDraft(two); editContextDraft(two, 'Unrelated unsaved context')
  await flushContextForSend(group)
  expect(api.saveConversationContext).toHaveBeenCalledOnce()
  expect(api.saveConversationContext).toHaveBeenCalledWith(one, { markdown: 'New individual context', revision: 0 })
  expect(contextDraft(two).saved).toBe('')
})

it('debounces automatic saves and cancels pending work on library cleanup', async () => {
  vi.useFakeTimers()
  api.conversationContext.mockResolvedValue(saved(one))
  api.saveConversationContext.mockImplementation(async (id, value) => saved(id, value.markdown, value.revision + 1))
  await loadContextDraft(one)
  editContextDraft(one, 'First'); await vi.advanceTimersByTimeAsync(300)
  editContextDraft(one, 'Latest'); await vi.advanceTimersByTimeAsync(399)
  expect(api.saveConversationContext).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(api.saveConversationContext).toHaveBeenCalledOnce()
  editContextDraft(one, 'Do not save after deletion'); clearContextDrafts()
  await vi.advanceTimersByTimeAsync(500)
  expect(api.saveConversationContext).toHaveBeenCalledOnce()
})
