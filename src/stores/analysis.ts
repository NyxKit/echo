import { reactive } from 'vue'
import { isEmptyDiscussion, newDiscussion, pruneEmptyDiscussions } from '../lib/discussion-state'
import { isLocalLibraryRuntime } from '../lib/library-api'
import { bindLibraryAnalysis, deleteLibraryDiscussion, disposeLibraryAnalysis, sendLibraryAnalysis, stopLibraryAnalysis } from './library-analysis'
import type { MessageSelection } from '../lib/message-selection'
import type { AnalysisInput, AnalysisPayload, ContextScope } from '../../shared/analysis-policy.mjs'
import { responseEvents } from '../../shared/response-events.mjs'
import { cancelDiscussionSubject, clearDiscussionSubjects, generateDiscussionSubject } from '../lib/discussion-subject'
import { clearContextDrafts } from './conversation-context'

export interface AnalysisTurn extends AnalysisInput {
  id: string
  answer: string
  referenceMap?: Record<string, string>
  status: 'sending' | 'complete' | 'failed' | 'canceled' | 'interrupted'
  error?: string
}
export interface AnalysisThread {
  id: string
  title: string
  sourceVersion?: string
  draftRevision?: number
  persisting?: boolean
  contextSource?: { sourceVersion: string; sourceParts: string[] }
  draft: string
  assets?: import('../../shared/prompt-assets.mjs').ConversationAssetChoice[]
  scope: ContextScope
  turns: AnalysisTurn[]
}

export interface AnalysisState {
  storageStatus?: 'loading' | 'saving' | 'saved' | 'error'
  storageError?: string
  selection: MessageSelection
  threads: AnalysisThread[]
  activeThread: string
}
const conversations = reactive(new Map<string, AnalysisState>())
const pending = new Map<string, AbortController>()
export function conversationAnalysis(id: string): AnalysisState {
  if (!conversations.has(id)) {
    const thread = newDiscussion()
    conversations.set(id, { selection: { ids: [] }, threads: [thread], activeThread: thread.id })
    if (isLocalLibraryRuntime()) bindLibraryAnalysis(id, conversations.get(id)!)
  }
  return conversations.get(id)!
}
export function addThread(state: AnalysisState) {
  const existing = state.threads.find(thread => !thread.draftRevision && !thread.persisting && isEmptyDiscussion(thread))
  if (existing) { state.activeThread = existing.id; pruneEmptyDiscussions(state); return }
  const thread = newDiscussion()
  state.threads.push(thread); state.activeThread = thread.id
  pruneEmptyDiscussions(state)
}
export function deleteThread(state: AnalysisState, id: string) {
  cancelDiscussionSubject(id)
  if (isLocalLibraryRuntime()) {
    void deleteLibraryDiscussion(state, id).then(() => {
      state.threads = state.threads.filter(thread => thread.id !== id)
      if (!state.threads.length) addThread(state)
      if (state.activeThread === id) state.activeThread = state.threads[0].id
    }).catch(() => {})
    return
  }
  stopAnalysis(id)
  state.threads = state.threads.filter(thread => thread.id !== id)
  if (!state.threads.length) addThread(state)
  if (state.activeThread === id) state.activeThread = state.threads[0].id
}
export function stopAnalysis(id: string) {
  if (isLocalLibraryRuntime()) {
    const thread = [...conversations.values()].flatMap(state => state.threads).find(thread => thread.id === id)
    if (thread) void stopLibraryAnalysis(thread)
  } else pending.get(id)?.abort()
}
export function clearAnalysis() {
  clearContextDrafts()
  clearDiscussionSubjects()
  disposeLibraryAnalysis()
  for (const controller of pending.values()) controller.abort()
  pending.clear(); conversations.clear()
}
export async function sendAnalysis(thread: AnalysisThread, payload: AnalysisPayload, onAccepted?: () => void) {
  if (isLocalLibraryRuntime()) return sendLibraryAnalysis(thread, payload, onAccepted)
  if (pending.has(thread.id)) return
  if (thread.sourceVersion && thread.sourceVersion !== payload.sourceVersion) throw new Error('The source changed. Start a new discussion.')
  thread.sourceVersion = payload.sourceVersion
  if (thread.title === 'New discussion') thread.title = payload.turn.question.slice(0, 60)
  const turn: AnalysisTurn = reactive({ ...payload.turn, id: payload.requestId, answer: '', status: 'sending' })
  thread.turns.push(turn)
  const controller = new AbortController()
  pending.set(thread.id, controller)
  try {
    const response = await fetch('/api/chatgpt/analyze', { method: 'POST', credentials: 'same-origin', signal: controller.signal,
      headers: { 'X-Echo-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    if (!response.ok || !response.body) {
      let message = 'The analysis could not start. Your question is preserved.'
      try { const error = await response.json(); if (typeof error.error === 'string') message = error.error } catch { /* Use the safe local fallback. */ }
      throw new Error(message)
    }
    if (thread.draft.trim() === payload.turn.question) thread.draft = ''
    thread.assets = []
    onAccepted?.()
    for await (const event of responseEvents(response.body)) {
      if (controller.signal.aborted) break
      if (event.type === 'delta' && typeof event.delta === 'string') turn.answer += event.delta
      if (event.type === 'failed') throw new Error(event.message || 'The response did not complete.')
      if (event.type === 'complete') { turn.status = 'complete'; break }
    }
    if (turn.status !== 'complete') throw new Error('The response was interrupted. A retry may repeat processing and plan usage.')
    void generateDiscussionSubject(thread, payload.model, payload.turn.question)
  } catch (error) {
    if (!thread.draft) thread.draft = payload.turn.question
    turn.status = controller.signal.aborted ? 'canceled' : 'failed'
    turn.error = controller.signal.aborted ? 'Stopped. OpenAI may already have processed part of this request.' : error instanceof Error ? error.message : 'The response did not finish.'
  } finally { pending.delete(thread.id) }
}
