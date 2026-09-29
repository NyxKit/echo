import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { importArchive, type Archive } from '../lib/archive'
import { ArchiveStorageError, forgetArchive, restoreArchive, saveArchive } from '../lib/archive-storage'

export function useArchiveStorage(adopt: (archive: Archive | undefined, signal?: AbortSignal) => Promise<void>) {
  const loading = ref(false)
  const restoring = ref(false)
  const saving = ref(false)
  const forgetting = ref(false)
  const saved = ref(false)
  const canForget = ref(false)
  const progress = ref(0)
  const error = ref('')
  const storageNotice = ref('')
  const loadingLabel = computed(() => restoring.value ? 'Restoring saved archive…' : `Reading your archive… ${progress.value}%`)
  let controller: AbortController | undefined

  function begin() {
    controller?.abort()
    controller = new AbortController()
    loading.value = true
    saving.value = false
    error.value = ''
    storageNotice.value = ''
    progress.value = 0
    return controller
  }
  function cancel() {
    controller?.abort()
    loading.value = false
    restoring.value = false
    saving.value = false
  }
  async function load(files: File[]) {
    if (!files.length || forgetting.value) return
    const current = begin()
    restoring.value = false
    try {
      const imported = await importArchive(files, (done, total) => { progress.value = total ? Math.round(done / total * 100) : 0 }, current.signal)
      current.signal.throwIfAborted()
      if (!imported.conversations.length) {
        error.value = 'No readable conversations found. Choose the extracted Instagram export folder with messages in JSON format.'
        return
      }
      await adopt(imported, current.signal)
      current.signal.throwIfAborted()
      loading.value = false
      saving.value = true
      const hadSavedArchive = saved.value || canForget.value
      saved.value = false
      canForget.value = true
      try {
        await saveArchive(files, current.signal)
        current.signal.throwIfAborted()
        saved.value = true
      } catch (failure) {
        if (current.signal.aborted) return
        storageNotice.value = failure instanceof ArchiveStorageError && failure.reason === 'quota'
          ? 'Not enough browser storage to save this archive. You can keep browsing for this session.'
          : 'This archive could not be saved in this browser. You can keep browsing for this session.'
        if (hadSavedArchive) storageNotice.value += ' A previously saved archive may reopen after refresh.'
      }
    } catch {
      if (!current.signal.aborted) error.value = 'This folder could not be read. Check folder access and try again.'
    } finally {
      if (controller === current) { loading.value = false; saving.value = false }
    }
  }

  async function restore() {
    const current = begin()
    restoring.value = true
    try {
      const files = await restoreArchive(current.signal)
      current.signal.throwIfAborted()
      if (!files) return
      canForget.value = true
      const imported = await importArchive(files, undefined, current.signal)
      current.signal.throwIfAborted()
      if (!imported.conversations.length) throw new ArchiveStorageError('invalid')
      await adopt(imported, current.signal)
      current.signal.throwIfAborted()
      saved.value = true
    } catch {
      if (!current.signal.aborted) {
        canForget.value = true
        storageNotice.value = 'Saved archive could not be restored. Open its folder again, or use Forget archive to remove the saved copy.'
      }
    } finally {
      if (controller === current) { loading.value = false; restoring.value = false }
    }
  }

  async function forget() {
    if (forgetting.value) return
    cancel()
    forgetting.value = true
    error.value = ''
    storageNotice.value = ''
    try {
      await forgetArchive()
      await adopt(undefined)
      canForget.value = false
      saved.value = false
    } catch {
      storageNotice.value = 'The saved archive could not be removed. Try Forget archive again, or clear this site’s data in your browser settings.'
    } finally { forgetting.value = false }
  }

  onMounted(() => { void restore() })
  onBeforeUnmount(cancel)
  return { loading, restoring, saving, forgetting, saved, canForget, progress, error, storageNotice, loadingLabel, load, cancel, forget }
}
