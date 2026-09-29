import type { Message } from './archive'

export function emojiHearts(text: string): string {
  return text.replace(/\u2764[\ufe0e\ufe0f]?/gu, '\u2764\ufe0f')
}

// Match whole export notices, optionally prefixed by their sender. Avoid
// treating a sentence that merely mentions an attachment/reaction as a notice.
export function isExtendedMessage(message: Message): boolean {
  let text = message.text.trim()
  for (const prefix of [`${message.sender} `, 'You ']) {
    if (text.startsWith(prefix)) { text = text.slice(prefix.length); break }
  }
  if (/^sent (?:an? |\d+ )?(?:attachments?|photos?|videos?|audio(?: clip)?|voice message|sticker|gif)[.!]?$/i.test(text)) return true
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
