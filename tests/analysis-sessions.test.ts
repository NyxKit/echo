import { describe, expect, it } from 'vitest'
import { exportDiscussions, importDiscussions } from '../src/lib/analysis-sessions'
import type { Conversation } from '../src/lib/archive'
import type { AnalysisState } from '../src/stores/analysis'

const conversation: Conversation = { id: 'synthetic', title: 'Synthetic', participants: [], category: 'Inbox', messages: [], pictures: {},
  sourceComplete: true, sourceParts: [JSON.stringify({ messages: [{ sender_name: 'Example', content: 'Synthetic message' }] })] }
const state = (): AnalysisState => ({ selection: { ids: [] }, activeThread: 'one', threads: [
  { id: 'one', title: 'First synthetic discussion', draft: 'Follow-up', scope: 'surrounding', turns: [{ id: 'turn', question: 'Question', focus: ['p1:m1'], context: { scope: 'selected', references: ['p1:m1'] }, images: [], excluded: [], answer: 'Answer', status: 'complete' }] },
  { id: 'two', title: 'Second synthetic discussion', draft: '', scope: 'selected', turns: [] },
] })
describe('explicit discussion session files', () => {
  it.each(['surrounding', 'full'] as const)('restores a %s discussion started without selection and its follow-ups', async scope => {
    const value = state()
    const first = value.threads[0].turns[0]
    first.focus = []
    first.context = scope === 'full' ? { scope } : { scope, references: ['p1:m1'] }
    value.threads[0].turns.push({ ...first, id: 'followup', question: 'Explain further', context: { scope: 'discussion' } })
    const text = await exportDiscussions(value, conversation)
    expect(JSON.parse(text).version).toBe(4)
    const restored = await importDiscussions(text, conversation)
    expect(restored[0].turns[0]).toMatchObject({ focus: [], context: first.context })
    expect(restored[0].turns[1].context).toEqual({ scope: 'discussion' })
    const invalid = JSON.parse(text); invalid.threads[0].turns[0].status = 'failed'
    await expect(importDiscussions(JSON.stringify(invalid), conversation)).rejects.toThrow('unsupported content')
  })
  it.each([2, 3])('keeps version-%i saved scopes supported', async version => {
    const saved = JSON.parse(await exportDiscussions(state(), conversation)); saved.version = version
    const restored = await importDiscussions(JSON.stringify(saved), conversation)
    expect(restored[0].turns[0].context).toEqual({ scope: 'selected', references: ['p1:m1'] })
  })
  it('restores attachment-free follow-ups only with preceding completed context in the same thread', async () => {
    const value = state()
    value.threads[0].turns.push({ id: 'followup', question: 'Now translate to French', focus: [], images: [], excluded: [], context: { scope: 'discussion' }, answer: 'Synthetic answer', status: 'complete' })
    const text = await exportDiscussions(value, conversation)
    const restored = await importDiscussions(text, conversation)
    expect(restored[0].turns[1]).toMatchObject({ focus: [], context: { scope: 'discussion' }, question: 'Now translate to French' })
    const invalid = JSON.parse(text)
    invalid.threads[0].turns[0].status = 'failed'
    await expect(importDiscussions(JSON.stringify(invalid), conversation)).rejects.toThrow('unsupported content')
    invalid.threads[0].turns.shift()
    await expect(importDiscussions(JSON.stringify(invalid), conversation)).rejects.toThrow('unsupported content')
  })
  it('round-trips independent discussions, drafts and stable focus references without storing source parts or credentials', async () => {
    const text = await exportDiscussions(state(), conversation)
    const raw = JSON.parse(text)
    expect(Object.keys(raw)).toEqual(['version', 'sourceVersion', 'threads'])
    expect(raw).not.toHaveProperty('sourceParts')
    const loaded = await importDiscussions(text, conversation)
    expect(loaded).toHaveLength(2)
    expect(loaded[0].turns[0]).toMatchObject({ focus: ['p1:m1'], question: 'Question', answer: 'Answer', status: 'complete' })
    expect(loaded[0].draft).toBe('Follow-up')
    expect(loaded[1].turns).toEqual([])
    expect(loaded[0].scope).toBe('surrounding')
    expect(loaded[1].scope).toBe('selected')
    expect(loaded[0].turns[0].context).toEqual({ scope: 'selected', references: ['p1:m1'] })
    expect(loaded[0].id).not.toBe(loaded[1].id)
  })
  it('blocks cross-conversation or changed-source restoration and invalid message references', async () => {
    const text = await exportDiscussions(state(), conversation)
    await expect(importDiscussions(text, { ...conversation, sourceParts: ['{"messages":[]}'] })).rejects.toThrow('different conversation or source version')
    const invalid = JSON.parse(text); invalid.threads[0].turns[0].focus = ['p8:m99']
    await expect(importDiscussions(JSON.stringify(invalid), conversation)).rejects.toThrow('unavailable messages')
  })
  it('restores a saved partial response as canceled, never as a completed answer', async () => {
    const value = state(); value.threads[0].turns[0].status = 'sending'
    const restored = await importDiscussions(await exportDiscussions(value, conversation), conversation)
    expect(restored[0].turns[0].status).toBe('canceled')
  })
  it('migrates version-one discussions explicitly as full-context history', async () => {
    const legacy = JSON.parse(await exportDiscussions(state(), conversation))
    legacy.version = 1
    for (const thread of legacy.threads) { delete thread.scope; for (const turn of thread.turns) delete turn.context }
    const restored = await importDiscussions(JSON.stringify(legacy), conversation)
    expect(restored[0].scope).toBe('full')
    expect(restored[0].turns[0].context).toEqual({ scope: 'full' })
  })
  it('rejects malformed saved scopes and unavailable surrounding references', async () => {
    const saved = JSON.parse(await exportDiscussions(state(), conversation))
    saved.threads[0].scope = 'automatic'
    await expect(importDiscussions(JSON.stringify(saved), conversation)).rejects.toThrow('unsupported content')
    saved.threads[0].scope = 'surrounding'
    saved.threads[0].turns[0].context = { scope: 'surrounding', references: ['p1:m1', 'p1:m999'] }
    await expect(importDiscussions(JSON.stringify(saved), conversation)).rejects.toThrow('unsupported content')
  })
})
