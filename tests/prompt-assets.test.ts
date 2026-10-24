import { describe, expect, it } from 'vitest'
import { preparePromptAssets } from '../src/lib/prompt-assets'
import { prepareAnalysis } from '../src/lib/analysis-context'
import { AssetIndex, type Conversation } from '../src/lib/archive'
import { validateAnalysis } from '../shared/analysis-policy.mjs'
import { type ConversationAssetChoice } from '../shared/prompt-assets.mjs'

function conversation(id: string, times: (number | null)[] = [1, 2]): Conversation {
  const records = times.map((timestamp_ms, index) => ({ sender_name: 'Synthetic Self', content: `Synthetic ${id} ${index}`, timestamp_ms }))
  return { id, title: 'Identical synthetic title', participants: ['Synthetic Self'], category: 'Inbox', pictures: {}, sourceComplete: true,
    sourceParts: [JSON.stringify({ title: 'Synthetic metadata', messages: records })],
    messages: records.map((record, index) => ({ id: `${id}-${index}`, sender: record.sender_name, text: record.content, timestamp: record.timestamp_ms,
      attachments: [], reactions: [], sourceDirectory: '', sourceReference: { part: 0, index } })) }
}
const choice = (conversationId: string, scope: ConversationAssetChoice['scope'] = 'week'): ConversationAssetChoice => ({ kind: 'conversation', id: crypto.randomUUID(), conversationId, scope })

describe('browser prompt conversation assets', () => {
  it('uses opaque source identity, exact windows, and stable local source references', async () => {
    const day = 86_400_000, other = conversation('synthetic-other', [0, day * 20, day * 30])
    const assets = await preparePromptAssets([other], [choice(other.id)], 'synthetic-primary')
    expect(assets[0]!.conversationId).toMatch(/^[a-f0-9]{64}$/)
    expect(assets[0]!.referenceMap).toEqual({ 'p1:m3': 'synthetic-other-2' })
    expect(JSON.parse(assets[0]!.sourceParts[0]!)).toEqual({ messages: { 2: { sender_name: 'Synthetic Self', content: 'Synthetic synthetic-other 2', timestamp_ms: day * 30 } } })
    const primary = conversation('synthetic-primary')
    const payload = await prepareAnalysis(primary, new AssetIndex([]), [], 'Synthetic comparison', [], 'synthetic-model', 'week')
    expect(validateAnalysis({ ...payload, turn: { ...payload.turn, assets } }).turn.assets).toEqual(assets)
  })

  it('prepares independent same-name conversations and preserves full metadata only for All time', async () => {
    const one = conversation('synthetic-one'), two = conversation('synthetic-two')
    const assets = await preparePromptAssets([one, two], [choice(one.id), choice(two.id, 'full')], 'synthetic-primary')
    expect(assets[0]!.conversationId).not.toBe(assets[1]!.conversationId)
    expect(JSON.parse(assets[0]!.sourceParts[0]!).title).toBeUndefined()
    expect(JSON.parse(assets[1]!.sourceParts[0]!).title).toBe('Synthetic metadata')
  })

  it('rejects missing, incomplete, duplicate, active and undated sources without silently changing the window', async () => {
    const other = conversation('synthetic-other', [null])
    await expect(preparePromptAssets([other], [choice(other.id)], 'primary')).rejects.toThrow('no usable timestamps')
    await expect(preparePromptAssets([], [choice(other.id)], 'primary')).rejects.toThrow('unavailable')
    await expect(preparePromptAssets([other], [choice(other.id, 'full')], other.id)).rejects.toThrow('invalid_prompt_assets')
    await expect(preparePromptAssets([other], [choice(other.id), choice(other.id)], 'primary')).rejects.toThrow('invalid_prompt_assets')
    other.sourceComplete = false
    await expect(preparePromptAssets([other], [choice(other.id, 'full')], 'primary')).rejects.toThrow('incomplete')
  })

  it('retains legacy turns and rejects namespace reuse or source-map injection', async () => {
    const one = conversation('primary'), other = conversation('other')
    const assets = await preparePromptAssets([other], [choice(other.id)], one.id)
    const payload = await prepareAnalysis(one, new AssetIndex([]), [], 'Synthetic question', [], 'synthetic-model', 'week')
    expect(validateAnalysis(payload).turn.assets).toBeUndefined()
    expect(() => validateAnalysis({ ...payload, history: [{ ...payload.turn, assets, answer: 'Synthetic answer' }],
      turn: { ...payload.turn, assets, context: { scope: 'discussion' } } })).toThrow('invalid_analysis')
    expect(() => validateAnalysis({ ...payload, turn: { ...payload.turn, assets: [{ ...assets[0], referenceMap: { 'p9:m9': 'injected' } }] } })).toThrow('invalid_prompt_assets')
  })
})
