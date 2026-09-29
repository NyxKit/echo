<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NyxButton, NyxIcon, NyxModal } from 'nyx-kit/components'
import { NyxVariant } from 'nyx-kit/types'
import { dateLabel, type AssetIndex } from '../lib/archive'
import type { GallerySelection } from '../lib/gallery'
import AttachmentView from './AttachmentView.vue'

const props = defineProps<{ selection: GallerySelection; assets: AssetIndex }>()
const emit = defineEmits<{ close: [] }>()
const modal = ref<{ $el: HTMLDialogElement }>()
const index = ref(props.selection.index)
const item = computed(() => props.selection.items[index.value])
const opener = document.activeElement as HTMLElement | null

function move(direction: number) {
  index.value = Math.max(0, Math.min(props.selection.items.length - 1, index.value + direction))
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    // Consume the native cancel too, so it cannot close the shelf underneath.
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }
  // Keep native video controls' seeking shortcuts while they have focus.
  if ((event.target as HTMLElement).closest('video')) return
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    event.stopPropagation()
    move(event.key === 'ArrowLeft' ? -1 : 1)
  }
}
onMounted(() => {
  modal.value?.$el.querySelector('.nyx-modal__close')?.setAttribute('aria-label', 'Close media viewer')
  // A boundary button can lose focus when it becomes disabled. Capture at the
  // window as well so Escape still belongs to this topmost dialog.
  window.addEventListener('keydown', onKey, true)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey, true)
  if (opener?.isConnected) opener.focus({ preventScroll: true })
})
</script>

<template>
  <NyxModal ref="modal" :model-value="true" title="Media viewer" custom-class="asset-lightbox" @close="emit('close')">
    <div class="asset-lightbox__stage">
      <AttachmentView :key="item.id" :attachment="item.attachment" :directory="item.message.sourceDirectory" :assets="assets" :preview="false" />
    </div>
    <template #footer>
      <div class="asset-lightbox__navigation">
        <NyxButton :variant="NyxVariant.Subtle" aria-label="Previous asset" :disabled="index === 0" @click="move(-1)"><NyxIcon name="chevron-left" :size="22" /></NyxButton>
        <div class="asset-lightbox__caption"><span role="status" aria-live="polite">{{ index + 1 }} of {{ selection.items.length }}</span><p>{{ item.message.sender }} · {{ dateLabel(item.message.timestamp) }}</p></div>
        <NyxButton :variant="NyxVariant.Subtle" aria-label="Next asset" :disabled="index === selection.items.length - 1" @click="move(1)"><NyxIcon name="chevron-right" :size="22" /></NyxButton>
      </div>
    </template>
  </NyxModal>
</template>
