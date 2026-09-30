import type { Message } from './archive'

export function emojiHearts(text: string): string {
  return text.replace(/\u2764[\ufe0e\ufe0f]?/gu, '\u2764\ufe0f')
}

const attachmentNotice = /^(?:(?:has|have) )?sent (?:you )?(?:an? |\d+ )?(?:attachments?|photos?|videos?|audio(?: clip)?|voice message|sticker|gif)[.!]?$/i

function normalizeNotice(text: string): string {
  return text.normalize('NFKC').replace(/[\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, '').replace(/\s+/gu, ' ').trim()
}

// Export notices can use only the sender's first name. Normalize solely for
// matching; keep original text for display when extended messages are enabled.
export function isExtendedMessage(message: Message): boolean {
  const original = normalizeNotice(message.text)
  const sender = normalizeNotice(message.sender)
  const firstName = sender.split(' ')[0]
  let text = original
  for (const name of [sender, firstName, 'You']) {
    const prefix = `${name} `
    if (name && text.toLowerCase().startsWith(prefix.toLowerCase())) { text = text.slice(prefix.length); break }
  }
  if (attachmentNotice.test(text)) return true
  // Handle the inverse too: a full name in the notice and a short sender name.
  const namedAttachment = /^(.+?) ((?:(?:has|have) )?sent .+)$/i.exec(original)
  if (namedAttachment && namedAttachment[1].split(' ')[0].toLowerCase() === firstName.toLowerCase() && attachmentNotice.test(namedAttachment[2])) return true
  if (/^liked (?:a|your) message[.!]?$/i.test(text)) return true
  const reaction = /^reacted (.+) to (?:your|a) message[.!]?$/i.exec(text)?.[1]
  return !!reaction && /^[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200d\ufe0e\ufe0f\u20e3\d#* ]+$/u.test(reaction)
}

export function displayMessage(message: Message, extended: boolean): Message | undefined {
  const hideText = !extended && isExtendedMessage(message)
  if (hideText && !message.attachments.length && !message.link) return undefined
  return { ...message, text: hideText ? '' : emojiHearts(message.text) }
}

export function conversationPreview(messages: Message[], extended: boolean): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = displayMessage(messages[index], extended)
    if (message) return message.text || (message.attachments.length ? 'Shared an attachment' : message.link ? 'Shared a link' : 'No messages')
  }
  return messages.length ? 'No visible messages' : 'No messages'
}
