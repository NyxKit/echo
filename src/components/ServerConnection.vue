<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NyxActionItem, NyxButton, NyxIcon, NyxModal, NyxCheckbox } from 'nyx-kit/components'
import { NyxSize, NyxTheme, NyxVariant } from 'nyx-kit/types'
import { createLibraryApi, LibraryApiError } from '../lib/library-api'

const api = createLibraryApi()
const emit = defineEmits<{ deleted: [] }>()
const deleteModal = ref<{ $el: HTMLDialogElement }>(), deleteTrigger = ref<{ $el: HTMLButtonElement }>()
const deletionOpen = ref(false), acknowledged = ref(false), deleting = ref(false), cleanupRequired = ref(false), deletionError = ref('')
watch(deletionOpen, async open => { await nextTick(); if (open) deleteModal.value?.$el.querySelector('.nyx-modal__close')?.setAttribute('aria-label', 'Close Delete library'); else deleteTrigger.value?.$el.focus() })
async function removeLibrary() {
  if (!acknowledged.value && !cleanupRequired.value || deleting.value) return
  deleting.value = true; deletionError.value = ''
  try {
    const result = await api.deleteLibrary(); cleanupRequired.value = result.cleanupRequired
    emit('deleted')
    if (result.deleted) { deletionOpen.value = false; acknowledged.value = false }
    else deletionError.value = 'Cleanup could not finish. Keep Echo open and retry. Importing is unavailable until cleanup completes.'
  } catch { deletionError.value = 'Deletion could not be confirmed. Check the server connection and retry.' }
  finally { deleting.value = false }
}
const state = ref<'connecting' | 'connected' | 'unpaired' | 'unavailable' | 'stopping'>('connecting')
const busy = ref(false)
const shutdownError = ref(false)
let controller: AbortController | undefined
let mounted = true
const label = computed(() => ({
  connecting: 'Connecting to Echo…', connected: 'Echo is running', unpaired: 'Connect this browser',
  unavailable: 'Echo is unavailable', stopping: 'Shutdown requested',
})[state.value])

async function refresh() {
  if (busy.value || state.value === 'stopping') return
  controller?.abort()
  const current = new AbortController()
  controller = current
  shutdownError.value = false
  const timeout = setTimeout(() => current.abort(), 10_000)
  state.value = 'connecting'
  try { const status = await api.status(current.signal); if (mounted && controller === current) { state.value = 'connected'; cleanupRequired.value = !!status.cleanupRequired } }
  catch (error) {
    if (mounted && controller === current) state.value = error instanceof LibraryApiError && error.code === 'session_required' ? 'unpaired' : 'unavailable'
  } finally { clearTimeout(timeout) }
}
async function quit() {
  if (busy.value) return
  busy.value = true
  shutdownError.value = false
  controller?.abort()
  controller = undefined
  try { await api.quit(); if (mounted) state.value = 'stopping' }
  catch (error) {
    if (mounted) {
      state.value = error instanceof LibraryApiError && error.code === 'session_required' ? 'unpaired' : 'unavailable'
      shutdownError.value = true
    }
  } finally { busy.value = false }
}
function onFocus() { if (state.value !== 'stopping') void refresh() }
onMounted(() => { void refresh(); window.addEventListener('focus', onFocus) })
onUnmounted(() => { mounted = false; controller?.abort(); window.removeEventListener('focus', onFocus) })
</script>

<template>
  <div class="server-connection" role="group" aria-label="Echo server">
    <div class="server-connection__row">
      <span class="server-connection__status" role="status"><NyxIcon name="monitor" :size="14" aria-hidden="true" />{{ label }}</span>
      <NyxButton v-if="state === 'unpaired' || state === 'unavailable'" :variant="NyxVariant.Subtle" :size="NyxSize.Small" @click="refresh">Retry</NyxButton>
    </div>
    <NyxActionItem title="Delete library" :theme="NyxTheme.Info">
      Permanently remove imported history, media, Echo discussions and local decisions. Your original exports and ChatGPT connection stay untouched. You will be asked to confirm.
      <template #action><NyxButton ref="deleteTrigger" :variant="NyxVariant.Soft" :theme="NyxTheme.Danger" :size="NyxSize.Small" :disabled="state !== 'connected'" @click="deletionOpen = true">{{ cleanupRequired ? 'Retry library cleanup' : 'Delete library' }}</NyxButton></template>
    </NyxActionItem>
    <NyxActionItem title="Quit Echo" :theme="NyxTheme.Info">
      Stop Echo on this device, including active imports and responses. Saved history stays in your library. Closing a browser tab alone keeps Echo running.
      <template #action><NyxButton :variant="NyxVariant.Soft" :size="NyxSize.Small" :disabled="state !== 'connected'" :loading="busy" @click="quit">Quit Echo</NyxButton></template>
    </NyxActionItem>
    <NyxModal ref="deleteModal" v-model="deletionOpen" title="Delete library" :static="deleting">
      <div class="server-connection__deletion">
        <p>This permanently removes imported history, managed media, saved Echo discussions, drafts, reading positions, and import decisions from Echo.</p>
        <p>Your original exports stay untouched. A new full Instagram export can rebuild the history it contains, but cannot recover Echo discussions or local decisions. Disconnecting ChatGPT and deleting provider data are separate actions.</p>
        <NyxCheckbox v-if="!cleanupRequired" v-model="acknowledged" tabindex="0" role="checkbox" aria-label="I understand this library cannot be restored." :aria-checked="acknowledged" @keydown.space.prevent="acknowledged = !acknowledged" label="I understand this library cannot be restored." />
        <p v-if="deletionError" role="alert">{{ deletionError }}</p>
        <div class="server-connection__row">
          <NyxButton :variant="NyxVariant.Subtle" :disabled="deleting" @click="deletionOpen = false">Cancel</NyxButton>
          <NyxButton :disabled="!acknowledged && !cleanupRequired" :loading="deleting" @click="removeLibrary">{{ cleanupRequired ? 'Retry cleanup' : 'Permanently delete library' }}</NyxButton>
        </div>
      </div>
    </NyxModal>
    <p v-if="shutdownError"  class="server-connection__help" role="alert">Shutdown could not be confirmed. Check the connection before trying again.</p>
    <p v-if="state === 'unpaired'" class="server-connection__help">Open Echo from its launcher, then return to this tab.</p>
    <p v-else-if="state === 'unavailable'" class="server-connection__help">Open Echo from its launcher if it has stopped.</p>
    <p v-else-if="state === 'stopping'" class="server-connection__help">Echo is finishing cleanup. Open it from the launcher to reconnect.</p>
  </div>
</template>

<style scoped lang="scss">
.server-connection {
  display: grid;
  gap: var(--nyx-gap-xl);
  font-size: var(--nyx-font-size-sm);
  color: var(--nyx-c-text-2);
  &__deletion { display: grid; gap: 16px; line-height: 1.5; p { margin: 0; } }
  &__row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  &__status { display: inline-flex; align-items: center; gap: 6px; }
  &__help { margin: 8px 0 0; line-height: 1.5; }
}
</style>
