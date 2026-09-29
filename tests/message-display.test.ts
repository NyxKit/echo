import { describe, expect, it } from 'vitest'
import type { Message } from '../src/lib/archive'
import { conversationPreview, displayMessage, emojiHearts, isExtendedMessage } from '../src/lib/message-display'

const message = (text: string, extra: Partial<Message> = {}): Message => ({
  id: 'synthetic', sender: 'Alex Example', text, timestamp: 0, attachments: [], reactions: [], sourceDirectory: 'synthetic', ...extra,
})

describe('extended messages', () => {
  it.each(['Alex Example sent an attachment.', 'You sent a photo.', 'Liked a message', 'Alex Example liked your message.', 'Reacted 😂 to your message', 'Alex Example reacted ❤️ to your message.'])('recognizes the complete notice %s', text => {
    expect(isExtendedMessage(message(text))).toBe(true)
    expect(displayMessage(message(text), false)).toBeUndefined()
    expect(displayMessage(message(text), true)?.text).toBe(text)
  })
  it.each(['I liked a message yesterday', 'Reacted badly to your message', 'Alex Example sent an attachment. Please read it.', 'Someone else sent an attachment.', 'I sent an attachment.', '❤️'])('keeps ordinary prose %s', text => {
    expect(isExtendedMessage(message(text))).toBe(false)
    expect(displayMessage(message(text), false)?.text).toBe(text)
  })
  it('hides only the notice when there is an attachment or link, without mutating the original', () => {
    const original = message('Alex Example sent an attachment.', { attachments: [{ uri: 'synthetic.png', kind: 'image' }], reactions: [{ actor: 'Jamie Sample', emoji: '❤' }] })
    expect(displayMessage(original, false)).toEqual({ ...original, text: '' })
    expect(original.text).toBe('Alex Example sent an attachment.')
    expect(displayMessage(message('Alex Example sent an attachment.', { link: 'https://example.com' }), false)?.link).toBe('https://example.com')
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
