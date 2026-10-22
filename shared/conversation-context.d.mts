export interface BackgroundNote { userId: string; conversationId: string; revision: number; kind: 'conversation' | 'group' | 'participant'; participantId?: string; label: string; markdown: string }
export interface ConversationBackground { version: 1; binding: string; notes: BackgroundNote[] }
export function validateBackground(value: unknown): ConversationBackground
export function editorMarkdown(value: string): string
