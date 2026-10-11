import type { AnalysisThread } from '../stores/analysis'
import { normalizeDiscussionSubject } from '../../shared/discussion-subject.mjs'

const pending = new Map<string, AbortController>()

export async function generateDiscussionSubject(thread: AnalysisThread, model: string, question: string) {
  const fallback = question.slice(0, 60)
  if (thread.turns.length !== 1 || thread.title !== fallback || pending.has(thread.id)) return
  const controller = new AbortController()
  pending.set(thread.id, controller)
  try {
    const response = await fetch('/api/chatgpt/subject', {
      method: 'POST', credentials: 'same-origin', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
      headers: { 'X-Echo-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ model, question }),
    })
    if (!response.ok) return
    const title = normalizeDiscussionSubject((await response.json()).title)
    if (title && !controller.signal.aborted && thread.title === fallback) thread.title = title
  } catch { /* The fallback subject remains usable if generation is unavailable. */ }
  finally { if (pending.get(thread.id) === controller) pending.delete(thread.id) }
}

export function cancelDiscussionSubject(id: string) {
  pending.get(id)?.abort()
  pending.delete(id)
}

export function clearDiscussionSubjects() {
  for (const controller of pending.values()) controller.abort()
  pending.clear()
}
