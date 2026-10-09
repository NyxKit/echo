import { effectScope, watch } from 'vue'
import { createLibraryApi, LibraryApiError } from '../lib/library-api'
import type { AnalysisPayload } from '../../shared/analysis-policy.mjs'
import type { AnalysisState, AnalysisThread, AnalysisTurn } from './analysis'
import type { LibraryDiscussionDetail, LibraryTurn } from '../../shared/library-types'
const api = createLibraryApi()
interface Binding {
  conversationId: string; state: AnalysisState; hydrated: boolean; updating: boolean;
  signatures: Map<string, string>; scope: ReturnType<typeof effectScope>; timer?: ReturnType<typeof setTimeout>;
  saving?: Promise<void>; ready: Promise<void>; loaded: Set<string>;
}
const bindings = new Map<string, Binding>(), polling = new Map<string, AbortController>()
const signature = (thread: AnalysisThread) => JSON.stringify([thread.title, thread.draft, thread.scope])
const turnError = (code?: string) => ({ outcome_unknown: 'The response was interrupted. OpenAI may have processed this request; Echo will not resend it automatically.',
  canceled: 'Stopped. OpenAI may already have processed part of this request.', provider_failed: 'The response did not finish. A retry may repeat processing and plan usage.',
  storage_failed: 'The response could not be saved. Check available disk space before trying again.', expired: 'Reconnect ChatGPT before sending again.',
  quota: 'ChatGPT plan capacity is unavailable. Review your plan limits before retrying.', provider_context: 'The provider could not accept this much context. Start a new discussion to omit earlier AI turns. Choose a smaller context in a new discussion if needed.' })[code ?? '']
function turnFrom(value: LibraryTurn): AnalysisTurn { return { ...value, error: turnError(value.error) } }
function bindingFor(thread: AnalysisThread) { return [...bindings.values()].find(value => value.state.threads.some(item => item.id === thread.id)) }
function saveError(binding: Binding, failure: unknown) {
  binding.state.storageStatus = 'error'
  binding.state.storageError = failure instanceof LibraryApiError && failure.code === 'library_draft_conflict'
    ? 'This draft changed in another tab. Copy any unsaved text before reloading saved discussions.'
    : 'Discussions could not be saved or refreshed. Your local draft is still here. Check the connection and try again.'
}
function adopt(binding: Binding, thread: AnalysisThread, saved: LibraryDiscussionDetail) {
  binding.updating = true
  Object.assign(thread, { title: saved.title, draft: saved.draft, scope: saved.scope, sourceVersion: saved.sourceVersion ?? undefined,
    draftRevision: saved.draftRevision, turns: saved.turns.map(turnFrom), contextSource: saved.contextSource })
  binding.signatures.set(thread.id, signature(thread)); binding.loaded.add(thread.id)
  binding.updating = false
  for (const turn of thread.turns) if (turn.status === 'sending') void poll(binding, thread, turn)
}
async function loadThread(binding: Binding, thread: AnalysisThread) {
  if (binding.loaded.has(thread.id) || !thread.draftRevision) return
  adopt(binding, thread, await api.discussion(thread.id))
}
async function initialize(binding: Binding) {
  binding.updating = true; binding.hydrated = false; binding.state.storageStatus = 'loading'; binding.state.storageError = ''
  try {
    const result = await api.discussions(binding.conversationId)
    binding.signatures.clear(); binding.loaded.clear()
    if (result.items.length) {
      binding.state.threads = result.items.map(value => ({ id: value.id, title: value.title, draft: value.draft, scope: value.scope,
        draftRevision: value.draftRevision, sourceVersion: value.sourceVersion ?? undefined, turns: [] }))
      if (!binding.state.threads.some(thread => thread.id === binding.state.activeThread)) binding.state.activeThread = binding.state.threads[0].id
      for (const thread of binding.state.threads) binding.signatures.set(thread.id, signature(thread))
      await loadThread(binding, binding.state.threads.find(thread => thread.id === binding.state.activeThread)!)
    }
    binding.hydrated = true; binding.state.storageStatus = 'saved'
  } catch (failure) { saveError(binding, failure) }
  finally { binding.updating = false }
  if (binding.hydrated) await flush(binding)
}
async function flush(binding: Binding) {
  if (binding.saving) { await binding.saving; return flush(binding) }
  if (!binding.hydrated || binding.updating) return
  clearTimeout(binding.timer)
  const dirty = binding.state.threads.filter(thread => binding.signatures.get(thread.id) !== signature(thread))
  if (!dirty.length) return
  binding.state.storageStatus = 'saving'; binding.state.storageError = ''
  binding.saving = (async () => {
    try {
      for (const thread of dirty) {
        const sent = signature(thread)
        const saved = await api.saveDiscussion(thread.id, { conversationId: binding.conversationId, title: thread.title, draft: thread.draft, scope: thread.scope, draftRevision: thread.draftRevision ?? 0 })
        thread.draftRevision = saved.draftRevision
        binding.signatures.set(thread.id, sent); binding.loaded.add(thread.id)
      }
      binding.state.storageStatus = binding.state.threads.some(thread => binding.signatures.get(thread.id) !== signature(thread)) ? 'saving' : 'saved'
    } catch (failure) { saveError(binding, failure); throw failure }
  })()
  try { await binding.saving } finally { binding.saving = undefined }
  if (binding.state.storageStatus === 'saving') await flush(binding)
}
function schedule(binding: Binding) {
  if (!binding.hydrated || binding.updating) return
  binding.state.storageStatus = 'saving'
  clearTimeout(binding.timer)
  binding.timer = setTimeout(() => { void flush(binding).catch(() => {}) }, 400)
}
async function poll(binding: Binding, thread: AnalysisThread, turn: AnalysisTurn) {
  if (polling.has(turn.id)) return
  const controller = new AbortController(); polling.set(turn.id, controller)
  try {
    while (!controller.signal.aborted) {
      try {
        const result = await api.turn(turn.id)
        if (controller.signal.aborted) return
        if (result.turn.status !== 'sending') {
          const saved = await api.discussion(thread.id)
          if (controller.signal.aborted) return
          // A completed turn clears only the submitted draft; unrelated edits
          // from another tab are governed by the draft revision check.
          // Keep the composer busy until this refresh is adopted so a newly
          // typed draft cannot be overwritten by the delayed saved response.
          adopt(binding, thread, saved)
          binding.state.storageStatus = 'saved'; return
        }
        Object.assign(turn, turnFrom(result.turn))
      } catch { binding.state.storageStatus = 'error'; binding.state.storageError = 'Response status is unavailable. Echo may still be working; reconnect without sending again.' }
      await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve() }; const timer = setTimeout(done, 750); controller.signal.addEventListener('abort', done, { once: true }) })
    }
  } finally { polling.delete(turn.id) }
}
export function bindLibraryAnalysis(conversationId: string, state: AnalysisState) {
  if (bindings.has(conversationId)) return
  const binding: Binding = { conversationId, state, hydrated: false, updating: true, signatures: new Map(), scope: effectScope(true), ready: Promise.resolve(), loaded: new Set() }
  bindings.set(conversationId, binding)
  binding.scope.run(() => {
    watch(() => state.threads.map(thread => [thread.id, thread.title, thread.draft, thread.scope]), () => schedule(binding), { deep: true, flush: 'sync' })
    watch(() => state.activeThread, async id => {
      if (!binding.hydrated || binding.updating) return
      try { await flush(binding); const thread = state.threads.find(item => item.id === id); if (thread) await loadThread(binding, thread) }
      catch (failure) { saveError(binding, failure) }
    })
  })
  binding.ready = initialize(binding).catch(failure => saveError(binding, failure))
}
export async function prepareLibraryAnalysis(thread: AnalysisThread, input: { question: string; focus: string[]; scope: string; model: string }) {
  const binding = bindingFor(thread)
  if (!binding) throw new Error('Reopen this conversation before preparing context.')
  await binding.ready; await flush(binding)
  if (!binding.hydrated || binding.state.storageStatus === 'error') throw new Error('Save your draft before preparing context.')
  try { return (await api.prepareTurn(thread.id, input)).payload }
  catch (failure) {
    if (failure instanceof LibraryApiError && failure.code === 'library_context_too_large') throw new Error('This context exceeds Echo’s transfer limit. Nothing was sent. Start a new discussion to omit earlier AI turns. Choose a smaller context in a new discussion if needed.')
    if (failure instanceof LibraryApiError && failure.code === 'library_image_limit') throw new Error('This discussion exceeds the eight-image limit. Nothing was sent. Select fewer images or start a new discussion.')
    if (failure instanceof LibraryApiError && failure.code === 'library_context_timestamps_unavailable') throw new Error('This conversation has no usable timestamps. Choose All time or attach specific messages.')
    if (failure instanceof LibraryApiError && failure.code === 'library_context_changed') throw new Error('This discussion belongs to an earlier source revision. Start a new discussion to use the current conversation.')
    throw new Error('Context could not be prepared. Check the library and ChatGPT connection, then try again.')
  }
}
export async function sendLibraryAnalysis(thread: AnalysisThread, payload: AnalysisPayload, onAccepted?: () => void) {
  const binding = bindingFor(thread)
  if (!binding) throw new Error('Reopen this conversation before sending.')
  await binding.ready; await flush(binding)
  if (!binding.hydrated || binding.state.storageStatus === 'error') throw new Error('Save your draft before sending.')
  try {
    const result = await api.acceptTurn(thread.id, payload)
    if (!thread.turns.some(turn => turn.id === result.turn.id)) thread.turns.push(turnFrom(result.turn))
    thread.sourceVersion = payload.sourceVersion
    onAccepted?.()
    const turn = thread.turns.find(turn => turn.id === result.turn.id)!
    await poll(binding, thread, turn)
  } catch (failure) {
    if (failure instanceof LibraryApiError && failure.code === 'library_context_changed') throw new Error('The source or discussion changed. Review context before sending again.')
    // A lost acceptance response is not proof that the server rejected work.
    try {
      const result = await api.turn(payload.requestId)
      const turn = turnFrom(result.turn); thread.turns.push(turn); onAccepted?.(); await poll(binding, thread, turn); return
    } catch { throw new Error('Echo could not confirm this send. Reopen the discussion to check for a saved response before trying again.') }
  }
}
export async function stopLibraryAnalysis(thread: AnalysisThread) {
  for (const turn of thread.turns) if (turn.status === 'sending') {
    try { Object.assign(turn, turnFrom((await api.cancelTurn(turn.id)).turn)) }
    catch { turn.error = 'Stop could not be confirmed. Reconnect to check this response.' }
  }
}
export async function deleteLibraryDiscussion(state: AnalysisState, id: string) {
  const binding = [...bindings.values()].find(value => value.state === state)
  if (!binding) return
  try { await flush(binding); await api.deleteDiscussion(id); binding.signatures.delete(id) }
  catch (failure) { saveError(binding, failure); throw failure }
}
export async function retryLibrarySave(state: AnalysisState) {
  const binding = [...bindings.values()].find(value => value.state === state)
  if (binding) { try { await flush(binding) } catch { /* Error is visible in state. */ } }
}
export async function reloadLibraryDiscussions(state: AnalysisState) {
  const binding = [...bindings.values()].find(value => value.state === state)
  if (binding) { await binding.saving?.catch(() => {}); await initialize(binding) }
}
export function disposeLibraryAnalysis() {
  for (const binding of bindings.values()) { clearTimeout(binding.timer); binding.scope.stop() }
  bindings.clear(); for (const controller of polling.values()) controller.abort(); polling.clear()
}
