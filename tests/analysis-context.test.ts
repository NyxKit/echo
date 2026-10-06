import { describe, expect, it } from 'vitest'
import { AssetIndex, type Conversation, type Message } from '../src/lib/archive'
import { contextVersion, prepareAnalysis } from '../src/lib/analysis-context'
import { analysisRequest, validateAnalysis, type AnalysisPayload } from '../shared/analysis-policy.mjs'
import { compactJson, scopedSourceParts, sourceText } from '../shared/analysis-source.mjs'

function fixture(): Conversation {
  const raw = Array.from({ length: 100 }, (_, index) => ({ content: `Synthetic ${index}`, timestamp_ms: index }))
  // Source parts run in a different order than the chronological timeline.
  return {
    id: 'synthetic', title: 'Synthetic', participants: [], category: 'Inbox', pictures: {}, sourceComplete: true,
    sourceParts: [JSON.stringify({ metadata: 'Full-context metadata', messages: raw.slice(50) }), JSON.stringify({ messages: raw.slice(0, 50) })],
    messages: raw.map((item, index) => ({ id: `m${index}`, text: item.content, attachments: [],
      sourceReference: { part: index >= 50 ? 0 : 1, index: index % 50 } } as unknown as Message)),
  }
}
const assets = new AssetIndex([])
const sourceRefs = (payload: AnalysisPayload) => payload.sourceParts.flatMap((part, p) => Object.keys(JSON.parse(part).messages).map(index => `p${p + 1}:m${Number(index) + 1}`))

describe('reviewed analysis context', () => {
  it('continues without a new selection using only completed discussion context and retained images', async () => {
    const first = await prepareAnalysis(fixture(), assets, ['m50'], 'Translate to English', [], 'synthetic-model', 'selected')
    first.turn.images = [{ reference: 'p1:m1', dataUrl: 'data:image/png;base64,c3ludGhldGlj', width: 1, height: 1 }]
    const history = [{ ...first.turn, answer: 'Synthetic translation' }]
    const followup = await prepareAnalysis(fixture(), assets, [], 'Now translate to French', history, 'synthetic-model', 'full')
    expect(followup.turn).toMatchObject({ focus: [], images: [], context: { scope: 'discussion' } })
    expect(followup.sourceParts).toEqual(first.sourceParts)
    expect(followup.history).toEqual(history)
    expect(analysisRequest(followup).input).toHaveLength(4)
    const next = await prepareAnalysis(fixture(), assets, [], 'Explain the wording', [...history, { ...followup.turn, answer: 'French translation' }], 'synthetic-model')
    expect(next.sourceParts).toEqual(first.sourceParts)
    expect(next.history).toHaveLength(2)
    const invalid = { ...followup, history: [] }
    expect(() => validateAnalysis(invalid)).toThrow('invalid_analysis')
    const expanded = structuredClone(followup); expanded.turn.context = { scope: 'full' }
    expect(() => validateAnalysis(expanded)).toThrow('invalid_analysis')
  })
  it.each([1, 12, 20, 60, 100])('starts without selection using the latest up to 20 chronological messages (%i available)', async count => {
    const conversation = fixture()
    conversation.messages = conversation.messages.slice(0, count)
    const payload = await prepareAnalysis(conversation, assets, [], 'What happened recently?', [], 'synthetic-model')
    const expected = Array.from({ length: Math.min(20, count) }, (_, i) => count - Math.min(20, count) + i)
      .map(index => `p${index >= 50 ? 1 : 2}:m${index % 50 + 1}`)
    expect(payload.turn).toMatchObject({ focus: [], images: [], excluded: [], context: { scope: 'surrounding', references: expected } })
    expect(sourceRefs(payload).sort()).toEqual([...expected].sort())
    expect(JSON.parse(payload.sourceParts[0])).not.toHaveProperty('metadata')
    expect(JSON.parse((analysisRequest(payload).input.at(-1) as any).content[0].text).focus).toEqual([])
    const followup = await prepareAnalysis(conversation, assets, [], 'Explain further', [{ ...payload.turn, answer: 'Synthetic answer' }], 'synthetic-model', 'full')
    expect(followup.sourceParts).toEqual(payload.sourceParts)
    expect(followup.turn.context).toEqual({ scope: 'discussion' })
  })
  it('starts without selection using the full conversation and retains it in follow-ups', async () => {
    const conversation = fixture()
    const payload = await prepareAnalysis(conversation, assets, [], 'Summarize', [], 'synthetic-model', 'full')
    expect(payload.turn).toMatchObject({ focus: [], context: { scope: 'full' }, images: [] })
    expect(sourceRefs(payload)).toHaveLength(100)
    expect(JSON.parse(payload.sourceParts[0]).metadata).toBe('Full-context metadata')
    const followup = await prepareAnalysis(conversation, assets, [], 'More detail', [{ ...payload.turn, answer: 'Summary' }], 'synthetic-model', 'selected')
    expect(followup.sourceParts).toEqual(payload.sourceParts)
    expect(followup.turn.context).toEqual({ scope: 'discussion' })
    const invalid = structuredClone(followup); invalid.turn.context = { scope: 'full' }
    expect(() => validateAnalysis(invalid)).toThrow('invalid_analysis')
  })
  it('rejects unavailable selections, empty conversations, blank prompts and selected-only starts without selection', async () => {
    await expect(prepareAnalysis(fixture(), assets, [], 'Explain', [], 'synthetic-model', 'selected')).rejects.toThrow('Select messages or choose')
    await expect(prepareAnalysis(fixture(), assets, ['missing'], 'Explain', [], 'synthetic-model')).rejects.toThrow('unavailable')
    await expect(prepareAnalysis({ ...fixture(), messages: [] }, assets, [], 'Explain', [], 'synthetic-model')).rejects.toThrow('no messages')
    await expect(prepareAnalysis(fixture(), assets, [], '  ', [], 'synthetic-model')).rejects.toThrow('could not be prepared')
    const payload = await prepareAnalysis(fixture(), assets, [], 'Explain', [], 'synthetic-model')
    payload.turn.context = { scope: 'selected', references: sourceRefs(payload) }
    expect(() => validateAnalysis(payload)).toThrow('invalid_analysis')
  })
  it('defaults to 20 neighbors on each side across source parts with stable original references', async () => {
    const payload = await prepareAnalysis(fixture(), assets, ['m50'], 'Explain', [], 'synthetic-model')
    expect(payload.turn.context.scope).toBe('surrounding')
    expect(payload.turn.focus).toEqual(['p1:m1'])
    expect(sourceRefs(payload)).toHaveLength(41)
    expect(sourceRefs(payload)).toContain('p2:m31')
    expect(sourceRefs(payload)).toContain('p1:m21')
    expect(sourceRefs(payload)).not.toContain('p1:m22')
    expect(JSON.parse(payload.sourceParts[0])).not.toHaveProperty('metadata')
    expect(payload.contextVersion).toBe(await contextVersion(payload.sourceParts))
    expect(payload.contextVersion).not.toBe(payload.sourceVersion)
  })
  it('merges overlapping windows and clips at boundaries without filling gaps between distant selections', async () => {
    const payload = await prepareAnalysis(fixture(), assets, ['m0', 'm1', 'm99'], 'Explain', [], 'synthetic-model')
    expect(sourceRefs(payload)).toHaveLength(43)
    expect(sourceRefs(payload)).not.toContain('p2:m40')
    expect(sourceRefs(payload)).not.toContain('p1:m10')
  })
  it('selected-only leaves unrelated messages and metadata out, even from a huge archive', async () => {
    const conversation = fixture()
    const large = JSON.parse(conversation.sourceParts![0]); large.messages[49].content = 'x'.repeat(25_000_000)
    conversation.sourceParts![0] = JSON.stringify(large)
    const payload = await prepareAnalysis(conversation, assets, ['m1'], 'Translate', [], 'synthetic-model', 'selected')
    expect(sourceRefs(payload)).toEqual(['p2:m2'])
    expect(JSON.stringify(payload).length).toBeLessThan(2000)
    expect(sourceText(payload.sourceParts)).not.toContain('Synthetic 0')
  })
  it('preserves earlier context and images when a later question narrows its scope', async () => {
    const conversation = fixture()
    const earlier = await prepareAnalysis(conversation, assets, ['m0'], 'Explain', [], 'synthetic-model')
    const historical = { ...earlier.turn, answer: 'Synthetic answer' }
    const payload = await prepareAnalysis(conversation, assets, ['m99'], 'Translate', [historical], 'synthetic-model', 'selected')
    expect(sourceRefs(payload)).toHaveLength(22)
    expect(payload.history[0]).toEqual(historical)
    expect(payload.turn.context).toEqual({ scope: 'selected', references: ['p1:m50'] })
    expect(sourceRefs(payload)).not.toContain('p1:m49')
  })
  it('retains full source metadata if any completed turn used full context', async () => {
    const conversation = fixture()
    const earlier = await prepareAnalysis(conversation, assets, ['m0'], 'Explain', [], 'synthetic-model', 'full')
    const payload = await prepareAnalysis(conversation, assets, ['m99'], 'Translate', [{ ...earlier.turn, answer: 'Answer' }], 'synthetic-model', 'selected')
    expect(sourceRefs(payload)).toHaveLength(100)
    expect(JSON.parse(payload.sourceParts[0]).metadata).toBe('Full-context metadata')
    expect(payload.sourceParts).toEqual(earlier.sourceParts)
  })
  it('rejects undisclosed records, metadata, invalid scopes and out-of-scope focus', async () => {
    const payload = await prepareAnalysis(fixture(), assets, ['m50'], 'Translate', [], 'synthetic-model', 'selected')
    const extra = structuredClone(payload); extra.sourceParts[1] = '{"messages":{"0":{"content":"Not disclosed"}}}'
    expect(() => validateAnalysis(extra)).toThrow('invalid_analysis')
    const metadata = structuredClone(payload); metadata.sourceParts[0] = '{"messages":{"0":{}},"secret":"Excluded"}'
    expect(() => validateAnalysis(metadata)).toThrow('invalid_analysis')
    const scope = structuredClone(payload); (scope.turn.context as { scope: string }).scope = 'automatic'
    expect(() => validateAnalysis(scope)).toThrow('invalid_analysis')
    const missing = structuredClone(payload); missing.turn.focus = ['p2:m1']
    expect(() => validateAnalysis(missing)).toThrow('invalid_analysis')
  })
  it('enforces the separately named transfer ceiling without trimming', async () => {
    const conversation = fixture()
    conversation.sourceParts![0] = JSON.stringify({ messages: [{ content: 'x'.repeat(24_000_000) }] })
    await expect(prepareAnalysis(conversation, assets, ['m50'], 'Explain', [], 'synthetic-model', 'full')).rejects.toThrow('24 MB transfer limit')
  })
})

describe('lossless source serialization', () => {
  const raw = '{ "metadata": {"id":9007199254740993123}, "messages" : [ {"text":"Keep  spaces, \\"quotes\\" and \\\\slashes", "nested":[{"messages":[1,2]}], "id":9007199254740993123}, {"text":"Excluded"} ] }'
  it('removes only insignificant whitespace and does not double-encode JSON or round numeric literals', () => {
    expect(JSON.parse(compactJson(raw))).toEqual(JSON.parse(raw))
    const text = sourceText([raw])
    expect(text).toContain('9007199254740993123')
    expect(text).toContain('Keep  spaces')
    expect(typeof JSON.parse(text).sourceParts[0].json).toBe('object')
  })
  it('extracts complete raw message records with original indexes and excludes everything else', () => {
    const scoped = scopedSourceParts([raw], [{ scope: 'selected', references: ['p1:m1'] }])
    expect(scoped[0]).toContain('9007199254740993123')
    expect(scoped[0]).not.toContain('metadata')
    expect(scoped[0]).not.toContain('Excluded')
    expect(JSON.parse(scoped[0]).messages['0']).toEqual(JSON.parse(raw).messages[0])
  })
})
