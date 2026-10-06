<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { NyxButton, NyxIcon } from 'nyx-kit/components'
import { NyxSize, NyxVariant } from 'nyx-kit/types'

const props = withDefaults(defineProps<{ title: string; icon?: string; variant?: 'analysis'; focusOnOpen?: boolean }>(), {
  focusOnOpen: true,
})
const emit = defineEmits<{ close: [] }>()
const titleId = useId()
const host = ref<HTMLElement>()
const media = window.matchMedia(props.variant === 'analysis' ? '(max-width: 999px)' : '(max-width: 1199px)')
const compact = ref(media.matches)
const opener = document.activeElement as HTMLElement | null
let restoreFocus = false
function resize() { compact.value = media.matches }
async function focusShelf() {
  await nextTick()
  if (host.value instanceof HTMLDialogElement && !host.value.open) host.value.showModal()
  if (compact.value || props.focusOnOpen) host.value?.querySelector<HTMLElement>('[data-shelf-close]')?.focus()
}
onMounted(() => { media.addEventListener('change', resize); void focusShelf() })
watch(compact, focusShelf)
onBeforeUnmount(() => {
  restoreFocus = !!host.value?.contains(document.activeElement)
  media.removeEventListener('change', resize)
  if (host.value instanceof HTMLDialogElement) host.value.close()
})
onUnmounted(() => { if (restoreFocus && opener?.isConnected) opener.focus({ preventScroll: true }) })
</script>

<template>
  <component :is="compact ? 'dialog' : 'aside'" ref="host" class="side-shelf" :class="{ 'side-shelf--analysis': variant === 'analysis' }" :aria-labelledby="titleId" :aria-modal="compact ? true : undefined" @cancel.prevent="emit('close')" @keydown.esc.prevent.stop="emit('close')">
    <header class="side-shelf__header"><h2 :id="titleId"><NyxIcon v-if="icon" :name="icon" :size="18" aria-hidden="true" />{{ title }}</h2><NyxButton data-shelf-close :variant="NyxVariant.Subtle" :size="NyxSize.Small" :aria-label="`Close ${title.toLowerCase()}`" @click="emit('close')"><NyxIcon name="x" :size="20" /></NyxButton></header>
    <div class="side-shelf__body"><slot /></div>
    <footer v-if="$slots.footer" class="side-shelf__footer"><slot name="footer" /></footer>
  </component>
</template>
