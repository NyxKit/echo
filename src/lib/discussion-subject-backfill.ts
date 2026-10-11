import type { createLibraryApi } from './library-api'

export interface SubjectBackfillProgress { total: number; processed: number; updated: number; skipped: number }
type SubjectApi = Pick<ReturnType<typeof createLibraryApi>, 'discussionSubjectCandidates' | 'generateDiscussionSubject'>

export async function backfillDiscussionSubjects(api: SubjectApi, model: string, signal: AbortSignal, progress: (value: SubjectBackfillProgress) => void) {
  const ids: string[] = []
  let after: string | null = ''
  do {
    signal.throwIfAborted()
    const page = await api.discussionSubjectCandidates(after, signal)
    ids.push(...page.items)
    after = page.after
  } while (after)
  const value = { total: ids.length, processed: 0, updated: 0, skipped: 0 }
  progress({ ...value })
  for (const id of ids) {
    signal.throwIfAborted()
    const result = await api.generateDiscussionSubject(id, model, signal)
    value.processed++
    if (result.updated) value.updated++
    else value.skipped++
    progress({ ...value })
  }
  return value
}
