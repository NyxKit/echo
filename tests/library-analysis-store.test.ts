import { afterEach, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { bindLibraryAnalysis, disposeLibraryAnalysis } from '../src/stores/library-analysis'
import type { AnalysisState } from '../src/stores/analysis'
import type { LibraryDiscussionDetail } from '../shared/library-types'

const api = vi.hoisted(() => ({ discussions: vi.fn(), discussion: vi.fn(), turn: vi.fn(), saveDiscussion: vi.fn() }))
vi.mock('../src/lib/library-api', () => ({ createLibraryApi: () => api, LibraryApiError: class extends Error {} }))
afterEach(() => { disposeLibraryAnalysis(); vi.resetAllMocks() })

it('keeps the composer busy until the completed discussion and cleared draft arrive together', async () => {
  const saved: LibraryDiscussionDetail = {
    id: crypto.randomUUID(), userId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
    title: 'Synthetic discussion', draft: 'Synthetic question', draftRevision: 1, scope: 'surrounding', sourceVersion: 'a'.repeat(64),
    turns: [{ id: crypto.randomUUID(), userId: crypto.randomUUID(), sequence: 0, question: 'Synthetic question',
      focus: [], context: { scope: 'discussion' }, images: [], excluded: [], referenceMap: {}, answer: '', status: 'sending' }],
  }
  const completed = structuredClone(saved)
  completed.draft = ''; completed.draftRevision = 2
  completed.turns[0]!.status = 'complete'; completed.turns[0]!.answer = 'Synthetic answer'
  let release!: (value: LibraryDiscussionDetail) => void
  const delayed = new Promise<LibraryDiscussionDetail>(resolve => { release = resolve })
  api.discussions.mockResolvedValue({ items: [saved] })
  api.discussion.mockResolvedValueOnce(saved).mockReturnValue(delayed)
  api.turn.mockResolvedValue({ turn: completed.turns[0] })
  const state = reactive<AnalysisState>({ selection: { ids: [] }, activeThread: saved.id, threads: [] })
  bindLibraryAnalysis(saved.conversationId, state)
  try {
    await vi.waitFor(() => expect(api.discussion).toHaveBeenCalledTimes(2))
    expect(state.threads[0]!.turns[0]!.status).toBe('sending')
    expect(state.threads[0]!.draft).toBe('Synthetic question')
  } finally { release(completed) }
  await vi.waitFor(() => expect(state.threads[0]!.turns[0]!.status).toBe('complete'))
  expect(state.threads[0]!.draft).toBe('')
  expect(state.threads[0]!.draftRevision).toBe(2)
})
