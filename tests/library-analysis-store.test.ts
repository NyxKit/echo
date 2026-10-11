import { afterEach, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { bindLibraryAnalysis, disposeLibraryAnalysis, refreshLibraryDiscussionSubjects, sendLibraryAnalysis } from '../src/stores/library-analysis'
import type { AnalysisState } from '../src/stores/analysis'
import type { LibraryDiscussionDetail } from '../shared/library-types'

const api = vi.hoisted(() => ({ discussions: vi.fn(), discussion: vi.fn(), turn: vi.fn(), saveDiscussion: vi.fn(), acceptTurn: vi.fn() }))
vi.mock('../src/lib/library-api', () => ({ createLibraryApi: () => api, LibraryApiError: class extends Error {} }))
afterEach(() => { disposeLibraryAnalysis(); vi.resetAllMocks(); vi.unstubAllGlobals() })

it('keeps the composer busy until the completed discussion and cleared draft arrive together', async () => {
  const saved: LibraryDiscussionDetail = {
    id: crypto.randomUUID(), userId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
    title: 'Synthetic discussion', draft: '', draftRevision: 2, scope: 'surrounding', sourceVersion: 'a'.repeat(64),
    turns: [{ id: crypto.randomUUID(), userId: crypto.randomUUID(), sequence: 0, question: 'Synthetic question',
      focus: [], context: { scope: 'discussion' }, images: [], excluded: [], referenceMap: {}, answer: '', status: 'sending' }],
  }
  const completed = structuredClone(saved)
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
    expect(state.threads[0]!.draft).toBe('')
  } finally { release(completed) }
  await vi.waitFor(() => expect(state.threads[0]!.turns[0]!.status).toBe('complete'))
  expect(state.threads[0]!.draft).toBe('')
  expect(state.threads[0]!.draftRevision).toBe(2)
})

it('clears the accepted prompt before polling finishes and automatically persists its generated subject', async () => {
  const saved: LibraryDiscussionDetail = {
    id: crypto.randomUUID(), userId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
    title: 'New discussion', draft: 'Synthetic question', draftRevision: 1, scope: 'week', sourceVersion: null, turns: [],
  }
  const payload = { requestId: crypto.randomUUID(), model: 'synthetic-model', sourceVersion: 'a'.repeat(64), contextVersion: 'b'.repeat(64),
    sourceParts: [], history: [], turn: { question: 'Synthetic question', focus: [], context: { scope: 'week' as const, references: [] }, images: [], excluded: [] } }
  const turn = { ...payload.turn, id: payload.requestId, userId: saved.userId, sequence: 0, referenceMap: {}, answer: '', status: 'sending' as const }
  const completed = { ...saved, title: payload.turn.question, draft: '', draftRevision: 2, sourceVersion: payload.sourceVersion, turns: [{ ...turn, answer: 'Synthetic answer', status: 'complete' as const }] }
  let release!: (value: { turn: typeof completed.turns[number] }) => void
  api.discussions.mockResolvedValue({ items: [saved] })
  api.discussion.mockResolvedValueOnce(saved).mockResolvedValue(completed)
  api.acceptTurn.mockResolvedValue({ accepted: true, turn, discussion: { title: completed.title, draft: '', draftRevision: 2 } })
  api.saveDiscussion.mockResolvedValue({ ...completed, draftRevision: 3 })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ title: 'Generated Synthetic Subject' })))
  api.turn.mockReturnValue(new Promise(resolve => { release = resolve }))
  const state = reactive<AnalysisState>({ selection: { ids: [] }, activeThread: saved.id, threads: [] })
  bindLibraryAnalysis(saved.conversationId, state)
  await vi.waitFor(() => expect(state.storageStatus).toBe('saved'))
  const thread = state.threads[0]!
  const accepted = vi.fn()
  const sent = sendLibraryAnalysis(thread, payload, accepted)
  try {
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    expect(thread.turns[0]!.status).toBe('sending')
    expect(thread.draft).toBe('')
    expect(thread.draftRevision).toBe(2)
    expect(api.saveDiscussion).not.toHaveBeenCalled()
  } finally { release({ turn: completed.turns[0]! }); await sent }
  expect(thread.turns[0]!.status).toBe('complete')
  expect(thread.draft).toBe('')
  await vi.waitFor(() => expect(thread.title).toBe('Generated Synthetic Subject'))
  await vi.waitFor(() => expect(api.saveDiscussion).toHaveBeenCalledWith(thread.id, expect.objectContaining({ title: 'Generated Synthetic Subject', draft: '', draftRevision: 2 })))
  expect(thread.turns).toHaveLength(1)
})


it('refreshes backfilled titles in loaded discussions while preserving unsaved local edits', async () => {
  const saved: LibraryDiscussionDetail = {
    id: crypto.randomUUID(), userId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
    title: 'Synthetic prompt', draft: '', draftRevision: 2, scope: 'week', sourceVersion: null, turns: [],
  }
  const state = reactive<AnalysisState>({ selection: { ids: [] }, activeThread: saved.id, threads: [] })
  api.discussions.mockResolvedValue({ items: [saved] }); api.discussion.mockResolvedValue(saved)
  bindLibraryAnalysis(saved.conversationId, state)
  await vi.waitFor(() => expect(state.storageStatus).toBe('saved'))
  const thread = state.threads[0]!
  api.discussions.mockResolvedValue({ items: [{ ...saved, title: 'Generated subject', draftRevision: 3 }] })
  await refreshLibraryDiscussionSubjects()
  expect(thread.title).toBe('Generated subject'); expect(thread.draftRevision).toBe(3)
  expect(api.saveDiscussion).not.toHaveBeenCalled()
  thread.draft = 'New local draft'
  api.discussions.mockResolvedValue({ items: [{ ...saved, title: 'Another subject', draftRevision: 4 }] })
  await refreshLibraryDiscussionSubjects()
  expect(thread.title).toBe('Generated subject'); expect(thread.draftRevision).toBe(3)
  expect(thread.draft).toBe('New local draft')
})
