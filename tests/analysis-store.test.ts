import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversationAnalysis, clearAnalysis, sendAnalysis, addThread } from '../src/stores/analysis'
import { pruneEmptyDiscussions } from '../src/lib/discussion-state'
import type { AnalysisPayload } from '../shared/analysis-policy.mjs'

afterEach(() => { clearAnalysis(); vi.unstubAllGlobals() })
const payload = (): AnalysisPayload => ({ requestId: crypto.randomUUID(), model: 'synthetic-model', sourceVersion: 'a'.repeat(64), contextVersion: 'b'.repeat(64),
  sourceParts: ['{"messages":{"0":{"content":"Synthetic"}}}'], history: [],
  turn: { question: 'Translate to English', focus: ['p1:m1'], context: { scope: 'selected', references: ['p1:m1'] }, images: [], excluded: [] } })

describe('analysis send acceptance', () => {
  it('generates a hidden subject after the first completed response without holding up the send', async () => {
    let release!: (value: Response) => void
    const request = vi.fn<typeof fetch>(async url => {
      if (url === '/api/chatgpt/subject') return new Promise(resolve => { release = resolve })
      return new Response('data: {"type":"delta","delta":"Synthetic answer"}\n\ndata: {"type":"complete"}\n\n')
    })
    vi.stubGlobal('fetch', request)
    const thread = conversationAnalysis('synthetic').threads[0]
    await sendAnalysis(thread, payload())
    expect(thread.turns[0].status).toBe('complete')
    expect(thread.turns).toHaveLength(1)
    expect(thread.title).toBe('Translate to English')
    expect(request).toHaveBeenCalledTimes(2)
    release(Response.json({ title: 'English Translation' }))
    await vi.waitFor(() => expect(thread.title).toBe('English Translation'))
    await sendAnalysis(thread, payload())
    expect(thread.turns).toHaveLength(2)
    expect(request.mock.calls.filter(([url]) => url === '/api/chatgpt/subject')).toHaveLength(1)
  })
  it('notifies acceptance before streaming finishes and preserves the immutable attachment', async () => {
    let finish!: () => void
    const body = new ReadableStream({ start(controller) { finish = () => { controller.enqueue(new TextEncoder().encode('data: {"type":"delta","delta":"Synthetic answer"}\n\ndata: {"type":"complete"}\n\n')); controller.close() } } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const thread = conversationAnalysis('synthetic').threads[0]
    thread.draft = 'Translate to English'
    const accepted = vi.fn()
    const sent = sendAnalysis(thread, payload(), accepted)
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    expect(thread.turns[0].status).toBe('sending')
    expect(thread.turns[0].focus).toEqual(['p1:m1'])
    expect(thread.draft).toBe('')
    thread.draft = 'A new draft'
    finish(); await sent
    expect(thread.turns[0].status).toBe('complete')
    expect(thread.draft).toBe('A new draft')
  })
  it('restores the submitted prompt if the accepted response fails', async () => {
    let fail!: () => void
    const body = new ReadableStream({ start(controller) { fail = () => { controller.enqueue(new TextEncoder().encode('data: {"type":"failed","message":"Synthetic failure"}\n\n')); controller.close() } } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const thread = conversationAnalysis('synthetic').threads[0]
    thread.draft = 'Translate to English'
    const accepted = vi.fn()
    const sent = sendAnalysis(thread, payload(), accepted)
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    expect(thread.draft).toBe('')
    fail(); await sent
    expect(thread.turns[0].status).toBe('failed')
    expect(thread.draft).toBe('Translate to English')
  })
  it('does not consume attachments when the service rejects the send', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Synthetic rejection' }, { status: 503 })))
    const thread = conversationAnalysis('synthetic').threads[0]
    thread.draft = 'Translate to English'
    const accepted = vi.fn()
    await sendAnalysis(thread, payload(), accepted)
    expect(accepted).not.toHaveBeenCalled()
    expect(thread.turns[0].status).toBe('failed')
    expect(thread.draft).toBe('Translate to English')
    expect(thread.turns[0].focus).toEqual(['p1:m1'])
    expect(fetch).toHaveBeenCalledOnce()
  })
})


it('discards abandoned blank placeholders while keeping drafts, custom titles, and submitted prompts', () => {
  const state = conversationAnalysis('synthetic'), initial = state.threads[0]
  addThread(state); addThread(state)
  expect(state.threads).toHaveLength(1)
  expect(state.activeThread).toBe(initial.id)
  initial.draft = 'Keep this unsent draft'
  addThread(state)
  expect(state.threads).toHaveLength(2)
  state.activeThread = initial.id
  pruneEmptyDiscussions(state)
  expect(state.threads.map(thread => thread.id)).toEqual([initial.id])
  addThread(state)
  const renamed = state.threads[1]
  renamed.title = 'My custom discussion'
  addThread(state)
  pruneEmptyDiscussions(state, true)
  expect(state.threads.map(thread => thread.id)).toEqual([initial.id, renamed.id])
  expect(state.activeThread).toBe(initial.id)
  initial.draft = ''
  initial.title = 'New discussion'
  initial.turns = [{ ...payload().turn, id: crypto.randomUUID(), answer: '', status: 'failed' }]
  addThread(state)
  pruneEmptyDiscussions(state, true)
  expect(state.threads.map(thread => thread.id)).toEqual([initial.id, renamed.id])
})
