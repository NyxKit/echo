import { reactive } from 'vue'
import { createLibraryApi, LibraryApiError } from '../lib/library-api'
import type { LibraryConversationContext } from '../../shared/library-types'

const api = createLibraryApi()
export interface ContextDraft {
  conversationId: string; draft: string; saved: string; revision: number; loaded: boolean; loading: boolean;
  error: string; conflict?: LibraryConversationContext; details?: LibraryConversationContext; editorVersion: number;
}
interface Entry { state: ContextDraft; load?: Promise<void>; saving?: Promise<void>; timer?: ReturnType<typeof setTimeout>; disposed?: boolean }
const entries = new Map<string, Entry>()
function entry(conversationId: string) {
  let value = entries.get(conversationId)
  if (!value) {
    value = { state: reactive({ conversationId, draft: '', saved: '', revision: 0, loaded: false, loading: false, error: '', editorVersion: 0 }) }
    entries.set(conversationId, value)
  }
  return value
}
export function contextDraft(conversationId: string) { return entry(conversationId).state }
export async function loadContextDraft(conversationId: string) {
  const item = entry(conversationId), state = item.state
  if (item.load) return item.load
  state.loading = !state.loaded
  item.load = (async () => {
    try {
      const saved = await api.conversationContext(conversationId)
      if (item.disposed) return
      state.details = saved
      if (!state.loaded) {
        state.draft = saved.markdown; state.saved = saved.markdown; state.revision = saved.revision
        state.loaded = true; state.error = ''
      } else if (state.draft === state.saved && !item.saving && !state.error) {
        if (state.saved !== saved.markdown) state.editorVersion++
        state.draft = saved.markdown; state.saved = saved.markdown; state.revision = saved.revision
      }
    } catch { if (!item.disposed) state.error = 'Context could not be loaded. Your draft has been kept.' }
    finally { state.loading = false; item.load = undefined }
  })()
  return item.load
}
export function editContextDraft(conversationId: string, markdown: string) {
  const item = entry(conversationId)
  if (!item.state.loaded || item.disposed) return
  item.state.draft = markdown
  clearTimeout(item.timer)
  if (!item.state.error) item.timer = setTimeout(() => { void flushContextDraft(conversationId).catch(() => {}) }, 400)
}
export async function flushContextDraft(conversationId: string) {
  const item = entries.get(conversationId)
  if (!item || item.disposed) return
  clearTimeout(item.timer)
  await item.load
  if (item.saving) { await item.saving; return flushContextDraft(conversationId) }
  const state = item.state
  if (!state.loaded || state.error) throw new Error(state.error || 'Load conversation context before sending.')
  if (state.draft === state.saved) return
  item.saving = (async () => {
    while (!item.disposed && state.draft !== state.saved) {
      const markdown = state.draft
      try {
        const saved = await api.saveConversationContext(conversationId, { markdown, revision: state.revision })
        if (item.disposed) return
        state.saved = saved.markdown; state.revision = saved.revision
      } catch (failure) {
        state.error = failure instanceof LibraryApiError && failure.code === 'library_note_conflict'
          ? 'Context changed in another tab. Compare the saved version with your draft.'
          : 'Context could not be saved. Your draft has been kept. Retry before sending.'
        if (failure instanceof LibraryApiError && failure.code === 'library_note_conflict') {
          try { state.conflict = await api.conversationContext(conversationId) } catch { /* Retry keeps the draft and reloads the conflict. */ }
        }
        throw new Error(state.error)
      }
    }
  })()
  try { await item.saving } finally { item.saving = undefined }
}
export async function retryContextDraft(conversationId: string) {
  const state = entry(conversationId).state
  if (state.conflict) return
  state.error = ''
  if (!state.loaded || state.draft === state.saved) await loadContextDraft(conversationId)
  else await flushContextDraft(conversationId)
}
export async function resolveContextConflict(conversationId: string, keepDraft: boolean) {
  const state = entry(conversationId).state, saved = state.conflict
  if (!saved) return
  state.saved = saved.markdown; state.revision = saved.revision; state.conflict = undefined; state.error = ''
  if (!keepDraft) { state.draft = saved.markdown; state.editorVersion++ }
  else await flushContextDraft(conversationId)
}
export async function flushContextForSend(conversationId: string) {
  if (!entries.size) return
  // Resolve at Send time, including empty notes with a local pending draft.
  let prior = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    let current: LibraryConversationContext
    try { current = await api.conversationContext(conversationId) }
    catch { throw new Error('Conversation context could not be checked. Your question and drafts have been kept. Check the library connection and retry.') }
    const ids = [conversationId, ...(current.relatedConversationIds ?? [])].sort()
    for (const id of ids) await flushContextDraft(id)
    const signature = ids.join(',')
    if (signature === prior) return
    prior = signature
  }
  throw new Error('Conversation context changed. Review it and send again.')
}
export function clearContextDrafts() {
  for (const item of entries.values()) { clearTimeout(item.timer); item.disposed = true }
  entries.clear()
}
