import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { contextChoices, contextLabel, timeWindowIndexes, timeWindows, type TimeScope } from '../shared/context-windows.mjs'
import { prepareAnalysis, contextVersion } from '../src/lib/analysis-context'
import { AssetIndex, type Conversation } from '../src/lib/archive'
import { openLibrary } from '../server/library/client.mjs'
import { validateAnalysis, type AnalysisInput, type AnalysisPayload } from '../shared/analysis-policy.mjs'
const hour = 3_600_000
const base = Date.UTC(2024, 2, 31)
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

describe('elapsed-time context windows', () => {
  it.each(Object.keys(timeWindows) as TimeScope[])('uses inclusive %s boundaries anchored to the latest archived message', scope => {
    const duration = timeWindows[scope]
    const messages = [base - duration - 1, base - duration, base - 1, base, null].map(timestamp => ({ timestamp }))
    expect(timeWindowIndexes(messages, [], scope)).toEqual([1, 2, 3])
  })
  it('merges centered windows without filling gaps between distant selections', () => {
    const messages = [-13, -12, 0, 10, 22, 23, 60, 88, 100, 112, 113].map(h => ({ timestamp: base + h * hour }))
    expect(timeWindowIndexes(messages, [2, 3, 8], '24h')).toEqual([1, 2, 3, 4, 7, 8, 9])
  })
  it('retains selected undated messages without guessing timestamps', () => {
    expect(timeWindowIndexes([{ timestamp: null }, { timestamp: base }], [0], 'week')).toEqual([0])
    expect(() => timeWindowIndexes([{ timestamp: null }], [], 'week')).toThrow('context_timestamps_unavailable')
  })
  it('labels all offered windows with Last or Surrounding and retains legacy labels', () => {
    expect(contextChoices).toEqual(['24h', '48h', 'week', 'month', 'year', 'full', 'selected'])
    expect(contextLabel('week')).toBe('Last week')
    expect(contextLabel('week', true)).toBe('Surrounding week')
    expect(contextLabel('full', true)).toBe('All time')
  })
  it('uses identical browser and database windows and persists the chosen scope', async () => {
    const timestamps = [-1000, -169, -168, -13, -12, 0, 12, 13, 168, 169, 1000].map(h => base + h * hour)
    const source = JSON.stringify({ title: 'Synthetic window test', messages: timestamps.map((timestamp_ms, i) => ({ sender_name: 'Synthetic Self', timestamp_ms, content: `Synthetic record ${i}` })) })
    const root = await mkdtemp(join(tmpdir(), 'echo-synthetic-windows-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
    let library = await openLibrary(root); cleanup.push(() => library.close())
    const owner = await library.resolveOwner({ label: 'Synthetic Self', evidenceJson: '{}' })
    const imported = await library.importConversation({ evidenceId: owner.evidenceId, title: 'Synthetic window test', participants: ['Synthetic Self'], sourceParts: [source] })
    const rows = await library.messages({ conversationId: imported.id })
    const id = randomUUID()
    await library.saveDiscussion({ id, conversationId: imported.id, title: 'New discussion', draft: 'Synthetic question', scope: 'week' })
    const conversation = { id: 'synthetic', title: 'Synthetic', participants: [], category: 'Inbox', pictures: {}, sourceComplete: true, sourceParts: [source], messages: timestamps.map((timestamp, i) => ({ id: `m${i}`, timestamp, sourceReference: { part: 0, index: i }, attachments: [] })) } as unknown as Conversation
    for (const scope of Object.keys(timeWindows) as TimeScope[]) {
      for (const indexes of [[], [5], [2, 8]]) {
        const browser = await prepareAnalysis(conversation, new AssetIndex([]), indexes.map(i => `m${i}`), 'Synthetic question', [], 'synthetic-model', scope)
        const server = await library.contextInput({ discussionId: id, question: 'Synthetic question', focus: indexes.map(i => rows[i].id), scope, model: 'synthetic-model' }) as { turn: AnalysisInput; sourceParts: string[] }
        expect(server.turn.context).toEqual(browser.turn.context)
        expect(server.turn.focus).toEqual(browser.turn.focus)
        expect(JSON.parse(server.sourceParts[0]).messages).toEqual(JSON.parse(browser.sourceParts[0]).messages)
        expect(validateAnalysis(browser).turn.context).toEqual(browser.turn.context)
      }
    }
    const context = await library.contextInput({ discussionId: id, question: 'Synthetic question', focus: [], scope: 'week', model: 'synthetic-model' }) as Pick<AnalysisPayload, 'model' | 'sourceVersion' | 'sourceParts' | 'history' | 'turn'>
    const payload = validateAnalysis({ ...context, requestId: randomUUID(), contextVersion: await contextVersion(context.sourceParts) })
    await library.acceptTurn({ discussionId: id, payload, providerAccount: 'a'.repeat(64) })
    await library.updateTurn({ turnId: payload.requestId, answer: 'Synthetic answer', status: 'complete' })
    await library.close(); library = await openLibrary(root)
    const saved = await library.discussion({ discussionId: id })
    expect(saved.scope).toBe('week')
    expect(saved.turns[0].context.scope).toBe('week')
    expect(saved.turns[0].answer).toBe('Synthetic answer')
  })
})
