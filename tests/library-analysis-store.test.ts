import { afterEach, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { bindLibraryAnalysis, disposeLibraryAnalysis, refreshLibraryDiscussionSubjects, sendLibraryAnalysis, retryLibrarySave, prepareLibraryAnalysis, deleteLibraryDiscussion } from '../src/stores/library-analysis'
import { newDiscussion, pruneEmptyDiscussions } from '../src/lib/discussion-state'
import { addThread } from '../src/stores/analysis'
import type { AnalysisState } from '../src/stores/analysis'
import type { LibraryDiscussionDetail } from '../shared/library-types'

const api = vi.hoisted(() => ({ discussions: vi.fn(), discussion: vi.fn(), turn: vi.fn(), saveDiscussion: vi.fn(), acceptTurn: vi.fn(), discardEmptyDiscussion: vi.fn(), deleteDiscussion: vi.fn(), prepareTurn: vi.fn() }))
vi.mock('../src/lib/library-api', () => ({ createLibraryApi: () => api, LibraryApiError: class extends Error {} }))
afterEach(() => { disposeLibraryAnalysis(); vi.resetAllMocks(); vi.unstubAllGlobals() })

it('persists and hydrates attachment-only drafts without discarding their discussion', async () => {
  const conversationId = crypto.randomUUID(), thread = newDiscussion()
  const state = reactive<AnalysisState>({ selection: { ids: [] }, activeThread: thread.id, threads: [thread] })
  api.discussions.mockResolvedValue({ items: [] }); api.saveDiscussion.mockResolvedValue({ draftRevision: 1 })
  bindLibraryAnalysis(conversationId, state)
  await vi.waitFor(() => expect(state.storageStatus).toBe('saved'))
  const assets = [{ kind: 'conversation' as const, id: crypto.randomUUID(), conversationId: crypto.randomUUID(), scope: 'month' as const }]
  state.threads[0]!.assets = assets
  await retryLibrarySave(state)
  expect(api.saveDiscussion).toHaveBeenCalledWith(thread.id, expect.objectContaining({ draft: '', assets }))
  pruneEmptyDiscussions(state, true)
  expect(state.threads).toHaveLength(1)
  expect(api.discardEmptyDiscussion).not.toHaveBeenCalled()
  disposeLibraryAnalysis()
  const saved = { ...thread, assets, userId: crypto.randomUUID(), conversationId, draftRevision: 1, sourceVersion: null, turns: [] }
  api.discussions.mockResolvedValue({ items: [saved] }); api.discussion.mockResolvedValue(saved)
  const restored = reactive<AnalysisState>({ selection: { ids: [] }, activeThread: '', threads: [] })
  bindLibraryAnalysis(conversationId, restored)
  await vi.waitFor(() => expect(restored.storageStatus).toBe('saved'))
  expect(restored.threads[0]!.assets).toEqual(assets)
  expect(api.saveDiscussion).toHaveBeenCalledTimes(1)
})

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


it('keeps untouched placeholders temporary and reuses them without accumulating saved discussions', async () => {
  const thread = newDiscussion()
  const state = reactive<AnalysisState>({ selection: { ids: [] }, activeThread: thread.id, threads: [thread] })
  api.discussions.mockResolvedValue({ items: [] })
  bindLibraryAnalysis(crypto.randomUUID(), state)
  await vi.waitFor(() => expect(state.storageStatus).toBe('saved'))
  for (let index=0; index<3; index++) addThread(state)
  state.threads[0]!.scope = 'month'
  await retryLibrarySave(state)
  expect(state.threads).toHaveLength(1)
  expect(state.activeThread).toBe(thread.id)
  expect(api.saveDiscussion).not.toHaveBeenCalled()
  await deleteLibraryDiscussion(state, thread.id)
  expect(api.deleteDiscussion).not.toHaveBeenCalled()
})

it('saves unsent drafts and conditionally removes their record when the last draft is cleared', async () => {
  const state = reactive<AnalysisState>({ selection: { ids: [] }, activeThread: '', threads: [] })
  api.discussions.mockResolvedValue({ items: [] })
  api.saveDiscussion.mockResolvedValue({ draftRevision: 1 })
  api.discardEmptyDiscussion.mockResolvedValue({ deleted: true })
  bindLibraryAnalysis(crypto.randomUUID(), state)
  await vi.waitFor(() => expect(state.storageStatus).toBe('saved'))
  const thread = state.threads[0]!
  thread.draft = 'Unsent synthetic prompt'
  await retryLibrarySave(state)
  expect(api.saveDiscussion).toHaveBeenCalledWith(thread.id, expect.objectContaining({ draft: 'Unsent synthetic prompt', draftRevision: 0 }))
  expect(thread.draftRevision).toBe(1)
  thread.draft = ' \n\t'
  await retryLibrarySave(state)
  expect(api.discardEmptyDiscussion).toHaveBeenCalledWith(thread.id, 1)
  expect(thread.draftRevision).toBeUndefined()
  expect(state.threads).toHaveLength(1)
  expect(api.saveDiscussion).toHaveBeenCalledTimes(1)
  expect(state.storageStatus).toBe('saved')
})

it('keeps local state when another tab changes a discussion before cleanup', async () => {
  const saved = { ...newDiscussion(), draft: 'Unsent synthetic prompt', draftRevision: 1, conversationId: crypto.randomUUID() }
  const state = reactive<AnalysisState>({ selection: { ids: [] }, activeThread: saved.id, threads: [] })
  api.discussions.mockResolvedValue({ items: [saved] }); api.discussion.mockResolvedValue(saved)
  api.discardEmptyDiscussion.mockResolvedValue({ deleted: false })
  bindLibraryAnalysis(saved.conversationId, state)
  await vi.waitFor(() => expect(state.storageStatus).toBe('saved'))
  state.threads[0]!.draft = ''
  await retryLibrarySave(state)
  expect(state.storageStatus).toBe('error')
  expect(state.threads[0]!.id).toBe(saved.id)
  expect(state.threads[0]!.draftRevision).toBe(1)
})

it('persists an explicitly prepared prompt even when its composer placeholder is still blank', async () => {
  const thread = newDiscussion(), conversationId = crypto.randomUUID()
  const state = reactive<AnalysisState>({ selection: { ids: [] }, activeThread: thread.id, threads: [thread] })
  api.discussions.mockResolvedValue({ items: [] }); api.saveDiscussion.mockResolvedValue({ draftRevision: 1 })
  api.prepareTurn.mockResolvedValue({ payload: { synthetic: true } })
  bindLibraryAnalysis(conversationId, state)
  await vi.waitFor(() => expect(state.storageStatus).toBe('saved'))
  const input = { question: 'Explicit synthetic question', focus: [], scope: 'week', model: 'synthetic-model' }
  expect(await prepareLibraryAnalysis(state.threads[0]!, input)).toEqual({ synthetic: true })
  expect(api.saveDiscussion).toHaveBeenCalledTimes(1)
  expect(api.prepareTurn).toHaveBeenCalledWith(thread.id, input)
  expect(api.discardEmptyDiscussion).not.toHaveBeenCalled()
})

it('retains an in-flight draft save until a subsequent cleanup can remove its saved record', async () => {
  const thread = newDiscussion(), other = { ...newDiscussion(), title: 'Keep my custom title' }
  const state = reactive<AnalysisState>({ selection: { ids: [] }, activeThread: thread.id, threads: [thread] })
  api.discussions.mockResolvedValue({ items: [] })
  let release!: (value: { draftRevision: number }) => void
  api.saveDiscussion.mockReturnValueOnce(new Promise(resolve => { release = resolve })).mockResolvedValue({ draftRevision: 1 })
  api.discardEmptyDiscussion.mockResolvedValue({ deleted: true })
  bindLibraryAnalysis(crypto.randomUUID(), state)
  await vi.waitFor(() => expect(state.storageStatus).toBe('saved'))
  const current = state.threads[0]!
  current.draft = 'Temporary synthetic draft'
  const saving = retryLibrarySave(state)
  await vi.waitFor(() => expect(current.persisting).toBe(true))
  current.draft = ''; state.threads.push(other); state.activeThread = other.id
  pruneEmptyDiscussions(state)
  expect(state.threads.some(item => item.id === current.id)).toBe(true)
  release({ draftRevision: 1 }); await saving
  expect(api.discardEmptyDiscussion).toHaveBeenCalledWith(current.id, 1)
  expect(state.threads.map(item => item.id)).toEqual([other.id])
})
