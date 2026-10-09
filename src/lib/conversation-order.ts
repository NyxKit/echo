import type { Conversation } from './archive'
import { dateLabel } from './archive'

export function conversationTimestamp(conversation: Conversation): number | null {
  return conversation.preview?.timestamp ?? conversation.messages.at(-1)?.timestamp ?? null
}

export function newestConversationsFirst(a: Conversation, b: Conversation): number {
  const left = conversationTimestamp(a), right = conversationTimestamp(b)
  if (left === null && right !== null) return 1
  if (right === null && left !== null) return -1
  return (right ?? 0) - (left ?? 0) || a.id.localeCompare(b.id)
}

export function conversationDateLabel(conversation: Conversation, now = new Date()): string {
  const timestamp = conversationTimestamp(conversation)
  return timestamp === null ? '' : dateLabel(timestamp, {
    month: 'short', day: 'numeric',
    ...(new Date(timestamp).getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
}
