import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { createLibraryApi, LibraryApiError } from '../lib/library-api'
import { normalizeMessage, type Archive, type Conversation } from '../lib/archive'
import { LibraryAssetIndex } from '../lib/library-assets'
import type { ReadingPosition } from './useMessageHistory'

export function useLibraryStorage(enabled: boolean, adopt: (archive: Archive | undefined, signal?: AbortSignal) => Promise<void>,
  restorePosition: (id: string, position: ReadingPosition) => void, restoreActive: (id: string) => void, restorePreferences?: (values: Record<string, string>) => void) {
  const api = createLibraryApi(), loading = ref(false), restoring = ref(false), saving = ref(false), forgetting = ref(false), saved = ref(false), canForget = ref(false)
  const progress = ref(0), error = ref(''), storageNotice = ref(''), readyId = ref(''), lastActive = ref('')
  const loadingLabel = computed(() => restoring.value ? 'Opening your library…' : 'Loading conversation…')
  let observedRevision = -1
  let restoreInitialSelection = true
  let archive: Archive | undefined, controller: AbortController | undefined, disposed = false
  let positionTimer: ReturnType<typeof setTimeout> | undefined
  const notice = (failure: unknown) => failure instanceof LibraryApiError && failure.code === 'session_required'
    ? 'Open Echo from its launcher to connect this browser.' : 'Your library could not be reached. Check the connection and retry.'
  async function refresh() {
    if (!enabled || disposed) return
    controller?.abort(); const current = new AbortController(); controller = current
    loading.value = true; restoring.value = true; error.value = ''; readyId.value = ''
    try {
      const status = await api.status(current.signal)
      current.signal.throwIfAborted()
      observedRevision = status.revision
      if (!status.owner) { archive = undefined; saved.value = false; await adopt(undefined, current.signal); restoreInitialSelection = false; return }
      const conversations: Conversation[] = []
      const assets = new LibraryAssetIndex()
      let after: string | undefined
      while (true) {
        const page = await api.conversations({ after, limit: 500 }, current.signal)
        for (const item of page.items) conversations.push(reactive({ id: item.id, title: item.title, participants: item.participants,
          category: item.category, messages: [], pictures: Object.fromEntries(item.pictures.filter(p => p.name).map(p => [p.name, { uri: assets.register(p.assetId), directory: '' }])),
          picture: item.pictures.find(p => !p.name) ? { uri: assets.register(item.pictures.find(p => !p.name)!.assetId), directory: '' } : undefined, sourceComplete: false, messageCount: item.messageCount, preview: item.preview }))
        if (page.items.length < 500) break
        after = page.items.at(-1)!.id
      }
      archive = { conversations, assets, selfName: status.owner.label, selfConfidence: 1, skipped: 0 }
      const preferences = await api.preferences()
      restorePreferences?.(preferences.values)
      current.signal.throwIfAborted()
      await adopt(archive, current.signal)
      saved.value = true; lastActive.value = preferences.values.activeConversation ?? ''
      if (restoreInitialSelection) {
        restoreInitialSelection = false
        if (lastActive.value) restoreActive(lastActive.value)
      }
    } catch (failure) { if (!current.signal.aborted) error.value = notice(failure) }
    finally { if (controller === current) { loading.value = false; restoring.value = false } }
  }
  async function loadConversation(id: string) {
    if (!enabled || !archive || disposed || readyId.value === id) return
    const conversation = archive.conversations.find(item => item.id === id)
    if (!conversation) return
    controller?.abort(); const current = new AbortController(); controller = current
    readyId.value = ''; loading.value = true; restoring.value = false; error.value = ''
    try {
      const before = await api.status(current.signal), messages = []
      const assets = archive.assets as LibraryAssetIndex
      let after = -1
      while (true) {
        const page = await api.messages(id, { after, limit: 500 }, current.signal)
        for (const item of page.items) {
          const message = normalizeMessage(JSON.parse(item.sourceJson), '', 0, item.ordinal)
          if (!message) throw new Error('Invalid library record')
          message.id = item.id
          if (message.linkPreview?.image) {
            const sourceAsset = item.sourceAssets.find(value => value.uri === message.linkPreview!.image)
            message.linkPreview.image = sourceAsset ? assets.register(sourceAsset.assetId) : undefined
          }
          message.versionCount = item.versionCount; message.assetConflictCount = item.assetConflictCount
          message.attachments = message.attachments.map((attachment, slot) => {
            if (attachment.remote) return attachment
            const binding = item.attachments.find(value => value.slot === slot)
            return { ...attachment, uri: binding?.assetId ? assets.register(binding.assetId) : `unavailable/${item.id}/${slot}` }
          })
          messages.push(message)
        }
        if (page.items.length < 500) break
        after = page.items.at(-1)!.ordinal
      }
      const position = await api.position(id, current.signal)
      const afterStatus = await api.status(current.signal)
      current.signal.throwIfAborted()
      if (before.revision !== afterStatus.revision) throw new Error('Library changed while loading')
      conversation.messages = messages
      conversation.libraryRevision = before.revision
      conversation.sourceComplete = false; conversation.sourceParts = undefined
      conversation.loadSource = async () => {
        const state = await api.status()
        if (conversation.sourceComplete && state.revision === conversation.libraryRevision) return
        const snapshot = await api.snapshot(conversation.id)
        if (disposed) throw new Error('Library closed')
        conversation.sourceParts = snapshot.sourceParts; conversation.libraryRevision = snapshot.revision; conversation.sourceComplete = true
        for (const message of conversation.messages) {
          const index = snapshot.references[message.id]
          message.sourceReference = index === undefined ? undefined : { part: 0, index }
        }
      }
      if (position.position) restorePosition(id, { start: Math.max(0, messages.findIndex(item => item.id === position.position!.messageId) - 20), top: 0,
        anchor: position.position.messageId, offset: position.position.offset })
      readyId.value = id
      await api.savePreference('activeConversation', id)
    } catch (failure) { if (!current.signal.aborted) error.value = notice(failure) }
    finally { if (controller === current) loading.value = false }
  }
  function savePosition(value: ReadingPosition, conversationId: string) {
    if (!enabled || !value.anchor || readyId.value !== conversationId) return
    clearTimeout(positionTimer)
    const anchor = value.anchor, offset = Math.round(value.offset ?? 0)
    positionTimer = setTimeout(() => {
      void api.savePosition(conversationId, { messageId: anchor, offset }).catch(() => { storageNotice.value = 'Reading position could not be saved. Check the connection.' })
    }, 250)
  }
  async function correctIdentity(label: string) {
    try { await api.correctIdentity(label); if (archive) { archive.selfName = label; archive.selfConfidence = 1 } }
    catch { storageNotice.value = 'Your identity correction could not be saved. Try again.' }
  }
  function saveSetting(key: 'appearance' | 'shelf', value: string) {
    if (!enabled || !archive || restoring.value) return
    void api.savePreference(key, value).catch(() => { storageNotice.value = 'Your display preference could not be saved. Check the connection.' })
  }
  async function checkRevision() {
    if (!enabled || disposed || loading.value) return
    try { if ((await api.status()).revision !== observedRevision) await refresh() } catch { /* Explicit retry remains available. */ }
  }
  function cancel() { controller?.abort(); loading.value = false }
  onMounted(() => { if (enabled) { void refresh(); window.addEventListener('focus', checkRevision) } })
  onBeforeUnmount(() => { disposed = true; window.removeEventListener('focus', checkRevision); cancel(); clearTimeout(positionTimer) })
  return { loading, restoring, saving, forgetting, saved, canForget, progress, error, storageNotice, readyId, loadingLabel,
    refresh, saveSetting, loadConversation, savePosition, correctIdentity, cancel, load: async (_files: File[]) => {}, forget: async () => {} }
}
