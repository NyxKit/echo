import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversationAnalysis, clearAnalysis, sendAnalysis } from '../src/stores/analysis'
import type { AnalysisPayload } from '../shared/analysis-policy.mjs'

afterEach(() => { clearAnalysis(); vi.unstubAllGlobals() })
const payload = (): AnalysisPayload => ({ requestId: crypto.randomUUID(), model: 'synthetic-model', sourceVersion: 'a'.repeat(64), contextVersion: 'b'.repeat(64),
  sourceParts: ['{"messages":{"0":{"content":"Synthetic"}}}'], history: [],
  turn: { question: 'Translate to English', focus: ['p1:m1'], context: { scope: 'selected', references: ['p1:m1'] }, images: [], excluded: [] } })

describe('analysis send acceptance', () => {
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
    finish(); await sent
    expect(thread.turns[0].status).toBe('complete')
    expect(thread.draft).toBe('')
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
  })
})
