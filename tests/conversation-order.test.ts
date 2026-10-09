import { describe, expect, it } from 'vitest'
import type { Conversation } from '../src/lib/archive'
import { conversationDateLabel, conversationTimestamp, newestConversationsFirst } from '../src/lib/conversation-order'

const conversation = (id: string, timestamp: number | null): Conversation => ({
  id, title: id, category: 'Inbox', participants: [], pictures: {}, messages: [], preview: { text: '', timestamp },
})

describe('sidebar chronology', () => {
  it('orders unloaded library summaries by complete dates across years, not IDs or month/day', () => {
    const items = [conversation('a', Date.UTC(2024, 11, 31)), conversation('z', Date.UTC(2025, 0, 1)), conversation('b', Date.UTC(2023, 11, 31))]
    expect(items.sort(newestConversationsFirst).map(item => item.id)).toEqual(['z', 'a', 'b'])
  })
  it('keeps missing dates last, including epoch and pre-epoch dates, with deterministic ties', () => {
    const items = [conversation('missing', null), conversation('b', 0), conversation('old', -1), conversation('a', 0)]
    expect(items.sort(newestConversationsFirst).map(item => item.id)).toEqual(['a', 'b', 'old', 'missing'])
  })
  it('uses loaded messages for the standalone viewer and exposes older years in the label', () => {
    const item = conversation('loaded', null)
    item.messages = [{ id: 'm', sender: 'Synthetic', text: '', timestamp: Date.UTC(2024, 6, 1, 12), attachments: [], reactions: [], sourceDirectory: '' }]
    expect(conversationTimestamp(item)).toBe(Date.UTC(2024, 6, 1, 12))
    expect(conversationDateLabel(item, new Date(2025, 6, 1))).toContain('2024')
    expect(conversationDateLabel(item, new Date(2024, 6, 1))).not.toContain('2024')
    expect(conversationDateLabel(conversation('empty', null))).toBe('')
  })
})
