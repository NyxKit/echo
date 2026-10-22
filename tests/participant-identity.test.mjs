import { describe, expect, it } from 'vitest'
import { participantIdentity } from '../server/library/participant-identity.mjs'
const self = { name: 'Synthetic Self', user_id: '100', is_self: true }
const person = (user_id, name = 'Synthetic Peer') => ({ name, user_id })
const resolve = observations => participantIdentity(observations, ['instagram:100'])
describe('validated participant account resolution', () => {
  it('keeps label-only, generic and thread identifiers unresolved', () => {
    for (const peer of [{ name: 'Synthetic Peer' }, { name: 'Synthetic Peer', id: '200' }, { name: 'Synthetic Peer', thread_id: '200' }]) {
      expect(resolve([[self, peer]])).toMatchObject({ kind: 'unknown', unresolved: true })
    }
  })
  it('resolves explicit accounts, keeps aliases together and identical labels apart', () => {
    expect(resolve([[self, person('200')], [self, person('200', 'Synthetic Alias')]])).toMatchObject({ kind: 'direct', unresolved: false, people: [{ id: 'instagram:200' }] })
    expect(resolve([[self, person('200'), person('300')]])).toMatchObject({ kind: 'group', unresolved: false, people: [{ id: 'instagram:200' }, { id: 'instagram:300' }] })
  })
  it('deduplicates aliases that explicitly claim the same account within a group', () => {
    expect(resolve([[self, person('200'), person('200', 'Synthetic Alias'), person('300')]])).toMatchObject({ kind: 'group', unresolved: false, people: [{ id: 'instagram:200' }, { id: 'instagram:300' }] })
  })
  it('rejects conflicts, missing owners and unsafe numeric values', () => {
    for (const observations of [[[self, person('200')], [self, person('300')]], [[person('200'), person('300')]], [[self, person('0')]], [[self, person(200)]], [[{ ...self, user_id: '999' }, person('200')]], [[self, person('200'), person('300')], [self, person('200'), person('400')]]]) {
      expect(resolve(observations).unresolved).toBe(true)
    }
  })
})
