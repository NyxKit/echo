import { describe, expect, it } from 'vitest'
import { currentMessageVersions, messageContentKey } from '../server/library/message-versions.mjs'

describe('reaction-only content versions', () => {
  it('ignores only top-level reactions and insignificant object-member order without rounding unknown values', () => {
    const original = '{"content":"Synthetic message","unknown":900719925474099312345,"timestamp_ms":2}'
    const reacted = '{"reactions":[{"actor":"Synthetic Peer","reaction":"👍"}],"timestamp_ms":2,"content":"Synthetic message","unknown":900719925474099312345}'
    expect(messageContentKey(original)).toBe(messageContentKey(reacted))
    expect(messageContentKey(original)).not.toBe(messageContentKey(original.replace('312345', '312346')))
    expect(messageContentKey(original)).not.toBe(messageContentKey(original.replace('Synthetic message', 'Synthetic edit')))
    expect(messageContentKey('{"unknown":1,"unknown":2}')).not.toBe(messageContentKey('{"unknown":3,"unknown":2}'))
    expect(messageContentKey('{"share":{"reactions":1}}')).not.toBe(messageContentKey('{"share":{"reactions":2}}'))
  })
  it('keeps one current state per content version and uses import order even when an old observation is imported again', () => {
    const observations = [
      { id: 'original', messageId: 'synthetic-message', source: '{"content":"Synthetic"}', cursor: 1, importedOrder: 5 },
      { id: 'reacted', messageId: 'synthetic-message', source: '{"content":"Synthetic","reactions":[]}', cursor: 2, importedOrder: 4 },
      { id: 'edited', messageId: 'synthetic-message', source: '{"content":"Edited"}', cursor: 3, importedOrder: 3 },
      { id: 'other', messageId: 'another-message', source: '{"content":"Synthetic"}', cursor: 4, importedOrder: 1 },
    ]
    expect(currentMessageVersions(observations).versions.map(value => value.id)).toEqual(['original', 'edited', 'other'])
    observations[1].importedOrder = 6
    const result = currentMessageVersions(observations)
    expect(result.versions.map(value => value.id)).toEqual(['reacted', 'edited', 'other'])
    expect(result.byMessage.get('synthetic-message').map(value => value.cursor)).toEqual([1, 3])
  })
})
