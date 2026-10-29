import type { AnalysisThread } from '../stores/analysis'

export function discussionTimestamp(thread: AnalysisThread): number | null {
  let latest = Date.parse(thread.lastInteractionAt ?? '')
  for (const turn of thread.turns) {
    const timestamp = Date.parse(turn.promptTime?.sentAt ?? '')
    if (Number.isFinite(timestamp) && (!Number.isFinite(latest) || timestamp > latest)) latest = timestamp
  }
  return Number.isFinite(latest) ? latest : null
}

export function newestDiscussionsFirst(a: AnalysisThread, b: AnalysisThread): number {
  const left = discussionTimestamp(a), right = discussionTimestamp(b)
  if (left === null && right !== null) return 1
  if (right === null && left !== null) return -1
  return (right ?? 0) - (left ?? 0) || a.id.localeCompare(b.id)
}
