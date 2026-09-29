import type { Conversation } from './archive'

export async function conversationRoutes(conversations: Conversation[]): Promise<Map<string, string>> {
  const encoder = new TextEncoder()
  const entries = await Promise.all(conversations.map(async conversation => {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`meta-chat-conversation:${conversation.id}`))
    const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    return [conversation.id, id] as const
  }))
  return new Map(entries)
}
