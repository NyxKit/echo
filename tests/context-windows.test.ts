import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { contextChoices, contextLabel, resolveTimeWindows, timeWindowIndexes, timeWindows, type TimeScope } from '../shared/context-windows.mjs'
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
  it.each(Object.keys(timeWindows) as TimeScope[])('centers %s and shifts its full duration at either archive edge', scope => {
    const duration = timeWindows[scope]
    for (const [anchor, start, end] of [
      [2 * duration, 1.5 * duration, 2.5 * duration],
      [duration / 4, 0, duration],
      [3.75 * duration, 3 * duration, 4 * duration],
      [0, 0, duration],
      [4 * duration, 3 * duration, 4 * duration],
    ]) {
      const times = [...new Set([0, start - 1, start, anchor, end, end + 1, 4 * duration])].filter(time => time >= 0 && time <= 4 * duration).sort((a, b) => a - b)
      const messages = times.map(time => ({ timestamp: base + time }))
      const selected = [times.indexOf(anchor)]
      expect(resolveTimeWindows(messages, selected, duration)).toEqual([[base + start, base + end]])
      expect(timeWindowIndexes(messages, selected, scope)).toEqual(times.flatMap((time, index) => time >= start && time <= end ? [index] : []))
    }
  })
  it.each([91, 181, 137])('resolves an arbitrary %s-day duration without a preset', days => {
    const day = 24 * hour
    const messages = [0, 1, 500, 999, 1000].map(time => ({ timestamp: base + time * day }))
    expect(resolveTimeWindows(messages, [1], days * day)).toEqual([[base, base + days * day]])
    expect(resolveTimeWindows(messages, [3], days * day)).toEqual([[base + (1000 - days) * day, base + 1000 * day]])
    expect(resolveTimeWindows(messages, [2], days * day)).toEqual([[base + (500 - days / 2) * day, base + (500 + days / 2) * day]])
    expect(resolveTimeWindows(messages, [], days * day)).toEqual([[base + (1000 - days) * day, base + 1000 * day]])
  })
  it('assigns an odd millisecond to the later half and preserves the duration at edges', () => {
    const messages = [0, 7, 47, 50, 54, 93, 100].map(timestamp => ({ timestamp }))
    expect(resolveTimeWindows(messages, [3], 7)).toEqual([[47, 54]])
    expect(resolveTimeWindows(messages, [0], 7)).toEqual([[0, 7]])
    expect(resolveTimeWindows(messages, [6], 7)).toEqual([[93, 100]])
  })
  it('covers short and single-timestamp archives without including unselected undated messages', () => {
    const messages = [null, 0, 10, 20, NaN, Infinity, 1.5, 8.64e15 + 1].map(timestamp => ({ timestamp }))
    expect(resolveTimeWindows(messages, [2], timeWindows.week)).toEqual([[0, 20]])
    expect(timeWindowIndexes(messages, [2], 'week')).toEqual([1, 2, 3])
    expect(timeWindowIndexes(messages, [0, 2], 'week')).toEqual([0, 1, 2, 3])
    expect(resolveTimeWindows([{ timestamp: base }], [0], timeWindows.year)).toEqual([[base, base]])
    expect(timeWindowIndexes([{ timestamp: base }, { timestamp: base }, { timestamp: null }], [0], 'year')).toEqual([0, 1])
  })
  it.each([0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid duration %s', duration => {
    expect(() => resolveTimeWindows([{ timestamp: base }], [0], duration)).toThrow('invalid_context_window')
  })
  it('merges centered windows without filling gaps between distant selections', () => {
    const messages = [-13, -12, 0, 10, 22, 23, 60, 88, 100, 112, 113].map(h => ({ timestamp: base + h * hour }))
    expect(timeWindowIndexes(messages, [2, 3, 8], '24h')).toEqual([1, 2, 3, 4, 7, 8, 9])
  })
  it('merges shifted windows and preserves sparse gaps regardless of message or selection order', () => {
    const messages = [100, 0, 1, 12, 24, 25, 50, 76, 88].map(h => ({ timestamp: base + h * hour }))
    expect(resolveTimeWindows(messages, [0, 3, 1, 3], timeWindows['24h'])).toEqual([[base, base + 24 * hour], [base + 76 * hour, base + 100 * hour]])
    expect(timeWindowIndexes(messages, [0, 3, 1], '24h')).toEqual([0, 1, 2, 3, 4, 7, 8])
  })
  it('retains selected undated messages without guessing timestamps', () => {
    expect(timeWindowIndexes([{ timestamp: null }, { timestamp: base }], [0], 'week')).toEqual([0])
    expect(() => timeWindowIndexes([{ timestamp: null }], [], 'week')).toThrow('context_timestamps_unavailable')
    expect(resolveTimeWindows([{ timestamp: null }], [0], timeWindows.week)).toEqual([])
    expect(timeWindowIndexes([{ timestamp: null }], [0], 'week')).toEqual([0])
  })
  it('labels all offered windows with Last or Surrounding and retains legacy labels', () => {
    expect(contextChoices).toEqual(['24h', '48h', 'week', 'month', '3months', '6months', 'year', 'full', 'selected'])
    expect(contextLabel('week')).toBe('Last week')
    expect(contextLabel('week', true)).toBe('Surrounding week')
    expect(contextLabel('full', true)).toBe('All time')
  })
  it.each([['3months', '3 months', 90], ['6months', '6 months', 180]] as const)('labels and resolves the %s preset', (scope, label, days) => {
    expect(contextLabel(scope)).toBe(`Last ${label}`)
    expect(contextLabel(scope, true)).toBe(`Surrounding ${label}`)
    expect(timeWindows[scope]).toBe(days * 24 * hour)
  })
  it('uses identical browser and database windows and persists the chosen scope', async () => {
    const timestamps = [-20000, -1000, -169, -168, -13, -12, 0, 12, 13, 168, 169, 1000, 20000].map(h => base + h * hour)
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
      for (const indexes of [[], [6], [2, 9], [0], [timestamps.length - 1]]) {
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
