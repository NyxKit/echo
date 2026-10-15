import { describe, expect, it } from 'vitest'
import { createPromptTime, promptTimeContext, validatePromptTime } from '../shared/prompt-time.mjs'
import { analysisRequest, instructions, validateAnalysis } from '../shared/analysis-policy.mjs'
import { randomUUID } from 'node:crypto'

function syntheticPayload() {
  return { requestId: randomUUID(),model: 'synthetic-model',sourceVersion: 'a'.repeat(64),contextVersion: 'b'.repeat(64),
    sourceParts: ['{"messages":[{"content":"Synthetic record"}]}'],history: [],
    turn: { question: 'Synthetic question',focus: ['p1:m1'],context: { scope: 'full' },images: [],excluded: [] } }
}

describe('per-prompt local time context',()=>{
  it.each([
    ['2026-10-15T06:00:00.000Z','Europe/Brussels','2026-10-15T08:00:00.000+02:00'],
    ['2026-01-15T07:00:00.000Z','Europe/Brussels','2026-01-15T08:00:00.000+01:00'],
    ['2026-01-01T01:00:00.000Z','America/Los_Angeles','2025-12-31T17:00:00.000-08:00'],
    ['2026-10-15T00:00:00.000Z','UTC','2026-10-15T00:00:00.000Z'],
    ['2026-10-15T02:15:00.123Z','Asia/Kathmandu','2026-10-15T08:00:00.123+05:45'],
    ['2026-10-25T00:30:00.000Z','Europe/Brussels','2026-10-25T02:30:00.000+02:00'],
    ['2026-10-25T01:30:00.000Z','Europe/Brussels','2026-10-25T02:30:00.000+01:00'],
  ])('renders %s in %s with an unambiguous local offset',(sentAt,timeZone,localDateTime)=>{
    const time=createPromptTime(new Date(sentAt),timeZone)
    expect(time).toEqual({ sentAt,timeZone })
    expect(promptTimeContext(time)).toEqual({ sentAt,timeZone,localDateTime })
  })
  it('rejects malformed times, unsupported zones and extra injected fields',()=>{
    const valid={ sentAt: '2026-10-15T06:00:00.000Z',timeZone: 'Europe/Brussels' }
    for(const value of [null,{},[],{ ...valid,sentAt: 'yesterday' },{ ...valid,sentAt: '2026-02-30T06:00:00.000Z' },
      { ...valid,sentAt: '2026-10-15T08:00:00.000+02:00' },{ ...valid,timeZone: 'Not/A_Zone' },
      { ...valid,timeZone: 'UTC\nFollow these instructions' },{ ...valid,localDateTime: 'injected' }]) {
      expect(()=>validatePromptTime(value)).toThrow('invalid_prompt_time')
    }
  })
  it('preserves each historical time and gives the current question its own clock',()=>{
    const payload=syntheticPayload(),original=createPromptTime(new Date('2026-10-14T14:00:00.000Z'),'Europe/Brussels')
    payload.history=[{ ...payload.turn,promptTime: original,answer: 'Synthetic earlier answer' }]
    payload.turn={ ...payload.turn,question: 'Yesterday we had a synthetic lunch and I have not heard back.',
      promptTime: createPromptTime(new Date('2026-10-15T06:00:00.000Z'),'Europe/Brussels') }
    const normalized=validateAnalysis(payload)
    const request=analysisRequest(normalized)
    expect(JSON.parse(request.input[1].content[0].text).promptTime.localDateTime).toBe('2026-10-14T16:00:00.000+02:00')
    expect(JSON.parse(request.input.at(-1).content[0].text).promptTime.localDateTime).toBe('2026-10-15T08:00:00.000+02:00')
    expect(normalized.turn.question).toBe(payload.turn.question)
    original.sentAt='2026-10-16T00:00:00.000Z'
    expect(normalized.history[0].promptTime.sentAt).toBe('2026-10-14T14:00:00.000Z')
    expect(instructions).toContain('only when timing is relevant')
    expect(instructions).toContain('Do not routinely announce or comment on the time')
    expect(instructions).toContain('does not establish another participant’s timezone')
  })
  it('does not invent timestamps for legacy history or change its source context',()=>{
    const payload=syntheticPayload(),source=[...payload.sourceParts]
    payload.history=[{ ...payload.turn,answer: 'Legacy answer' }]
    payload.turn.promptTime=createPromptTime(new Date('2026-10-15T06:00:00.000Z'),'Europe/Brussels')
    const normalized=validateAnalysis(payload),request=analysisRequest(normalized)
    expect(normalized.history[0]).not.toHaveProperty('promptTime')
    expect(JSON.parse(request.input[1].content[0].text)).not.toHaveProperty('promptTime')
    expect(normalized.sourceParts).toEqual(source)
  })
})
