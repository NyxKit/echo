import { describe, expect, it } from 'vitest'
import type { Message } from '../src/lib/archive'
import { conversationPreview, displayMessage, emojiHearts, isExtendedMessage } from '../src/lib/message-display'

const message = (text: string, extra: Partial<Message> = {}): Message => ({
  id: 'synthetic', sender: 'Alex Example', text, timestamp: 0, attachments: [], reactions: [], sourceDirectory: 'synthetic', ...extra,
})

describe('extended messages', () => {
  it.each(['Alex Example sent an attachment.', 'Alex sent an attachment.', 'Alex\u00a0Example\u202fsent an attachment.\u200e', 'Alex Example sent you an attachment.', 'Alex Example has sent an attachment', 'Alex Example has sent an attachment.', 'You have sent an attachment.', 'You sent a photo.', 'Liked a message', 'Alex Example liked your message.', 'Reacted 😂 to your message', 'Alex Example reacted ❤️ to your message.'])('recognizes the complete notice %s', text => {
    expect(isExtendedMessage(message(text))).toBe(true)
    expect(displayMessage(message(text), false)).toBeUndefined()
    expect(displayMessage(message(text), true)?.text).toBe(text)
  })
  it.each(['I liked a message yesterday', 'Reacted badly to your message', 'Alex Example sent an attachment. Please read it.', 'Alex Example has sent an attachment. Please read it.', 'Alex sent an attachment. Please read it.', 'Someone else sent an attachment.', 'Someone else has sent an attachment.', 'I sent an attachment.', '❤️'])('keeps ordinary prose %s', text => {
    expect(isExtendedMessage(message(text))).toBe(false)
    expect(displayMessage(message(text), false)?.text).toBe(text)
  })
  it.each(['Alex Example sent an attachment.', 'Alex Example has sent an attachment', 'Alex sent an attachment.', 'Alex\u00a0sent an attachment.\u200e'])('hides only the notice %s when there is an attachment or link, without mutating the original', text => {
    const original = message(text, { attachments: [{ uri: 'synthetic.png', kind: 'image' }], reactions: [{ actor: 'Jamie Sample', emoji: '❤' }] })
    expect(displayMessage(original, false)).toEqual({ ...original, text: '' })
    expect(original.text).toBe(text)
    expect(displayMessage(message(text, { link: 'https://example.com' }), false)?.link).toBe('https://example.com')
    expect(conversationPreview([original], false)).toBe('Shared an attachment')
  })
  it('recognizes a full-name notice when the sender field contains only the first name', () => {
    expect(isExtendedMessage(message('Alex Example sent an attachment.', { sender: 'Alex' }))).toBe(true)
  })
  it('previews the most recent visible content', () => {
    const messages = [message('Hello ❤'), message('Liked a message')]
    expect(conversationPreview(messages, false)).toBe('Hello ❤️')
    expect(conversationPreview(messages, true)).toBe('Liked a message')
    expect(conversationPreview([messages[1]], false)).toBe('No visible messages')
  })
})

it('uses emoji presentation for plain and text-style hearts without duplicating selectors or breaking sequences', () => {
  expect(emojiHearts('❤ ❤︎ ❤️ ❤️‍🔥 💕')).toBe('❤️ ❤️ ❤️ ❤️‍🔥 💕')
  expect(emojiHearts(emojiHearts('❤'))).toBe('❤️')
})
