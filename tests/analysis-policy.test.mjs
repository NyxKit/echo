import { describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { analysisRequest, validateAnalysis } from '../shared/analysis-policy.mjs'

export function syntheticPayload() {
  const sourceParts = [
    JSON.stringify({ title: 'Synthetic discussion', extra: { preserve: 'unknown source field' }, messages: [{ sender_name: 'Example', content: 'Before' }] }),
    JSON.stringify({ messages: [{ sender_name: 'Example', content: 'Focus' }, { sender_name: 'Sample', content: 'After' }] }),
  ]
  return { requestId: randomUUID(), model: 'gpt-6.1-sol', sourceParts,
    contextVersion: createHash('sha256').update(JSON.stringify(sourceParts)).digest('hex'),
    sourceVersion: createHash('sha256').update(JSON.stringify(sourceParts)).digest('hex'), history: [],
    turn: { question: 'Explain this passage.', focus: ['p2:m1'], context: { scope: 'full' }, images: [], excluded: [] } }
}

describe('explicit analysis request policy', () => {
  it('preserves every exact source part and unknown field and sends the focus separately', () => {
    const payload = syntheticPayload()
    const request = analysisRequest(payload)
    expect(request).toMatchObject({ model: payload.model, tools: [], store: false, stream: true })
    expect(JSON.parse(request.input[0].content[0].text).sourceParts.map(part => part.json)).toEqual(payload.sourceParts.map(JSON.parse))
    expect(JSON.parse(request.input.at(-1).content[0].text).focus).toEqual(['p2:m1'])
    for (const forbidden of ['truncation', 'max_output_tokens', 'previous_response_id', 'conversation', 'background']) expect(request).not.toHaveProperty(forbidden)
  })
  it('keeps historical focus and question immutable when a follow-up selects a different message', () => {
    const payload = syntheticPayload()
    payload.history = [{ question: 'Earlier question', focus: ['p1:m1'], context: { scope: 'full' }, images: [], excluded: [], answer: 'Earlier answer' }]
    const request = analysisRequest(payload)
    expect(JSON.parse(request.input[1].content[0].text).focus).toEqual(['p1:m1'])
    expect(request.input[2]).toEqual({ role: 'assistant', content: 'Earlier answer' })
    expect(JSON.parse(request.input[3].content[0].text).focus).toEqual(['p2:m1'])
  })
  it('rejects missing anchors and malformed models without imposing the old 600 KB text limit', () => {
    const missing = syntheticPayload(); missing.turn.focus = ['p9:m9']
    expect(() => validateAnalysis(missing)).toThrow('invalid_analysis')
    const model = syntheticPayload(); model.model = 'https://example.invalid/model'
    expect(() => validateAnalysis(model)).toThrow('invalid_analysis')
    const large = syntheticPayload(); large.sourceParts[0] = JSON.stringify({ messages: [{ content: 'x'.repeat(610_000) }] })
    expect(() => validateAnalysis(large)).not.toThrow()
  })
  it('accepts catalog model identifiers without a hardcoded release list', () => {
    const payload = syntheticPayload(); payload.model = 'synthetic-account-model'
    expect(analysisRequest(payload).model).toBe('synthetic-account-model')
  })
  it('accepts only selected bounded inline image copies and never provider-fetchable URLs', () => {
    const payload = syntheticPayload()
    const image = { reference: 'p2:m1', dataUrl: 'data:image/png;base64,c3ludGhldGlj', width: 100, height: 100 }
    payload.turn.images = [image]
    expect(analysisRequest(payload).input.at(-1).content.at(-1)).toMatchObject({ type: 'input_image', image_url: image.dataUrl })
    for (const invalid of [{ ...image, reference: 'p1:m1' }, { ...image, width: 5000 }, { ...image, dataUrl: 'https://example.invalid/image.png' }]) {
      payload.turn.images = [invalid]
      expect(() => validateAnalysis(payload)).toThrow('invalid_image')
    }
    payload.turn.images = Array.from({ length: 9 }, () => image)
    expect(() => validateAnalysis(payload)).toThrow('image_limit')
  })
})
