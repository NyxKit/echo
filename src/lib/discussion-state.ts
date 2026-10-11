import { analysisPreferences } from '../stores/analysis-preferences'
import type { AnalysisState, AnalysisThread } from '../stores/analysis'

export function newDiscussion(): AnalysisThread {
  return { id: crypto.randomUUID(), title: 'New discussion', draft: '', scope: analysisPreferences.defaultContext, turns: [] }
}
export function isEmptyDiscussion(thread: AnalysisThread) {
  return thread.title === 'New discussion' && !thread.draft.trim() && !thread.turns.length
}
export function pruneEmptyDiscussions(state: AnalysisState, includeActive = false) {
  const kept = state.threads.filter(thread => thread.draftRevision || thread.persisting || !isEmptyDiscussion(thread) || !includeActive && thread.id === state.activeThread)
  if (!kept.length || kept.length === state.threads.length) return
  if (!kept.some(thread => thread.id === state.activeThread)) state.activeThread = kept[0]!.id
  state.threads = kept
}
