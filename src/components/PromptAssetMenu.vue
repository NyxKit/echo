<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NyxDropdown, NyxDropdownItem, NyxIcon } from 'nyx-kit/components'
import { NyxPosition, NyxSize } from 'nyx-kit/types'

const props = defineProps<{ disabled: boolean; atLimit: boolean }>()
const emit = defineEmits<{ conversation: [] }>()
const dropdown = ref<{ $el: HTMLElement }>()
const options = computed(() => [
  { value: 'conversation', label: 'Add conversation', icon: 'messages-square', disabled: props.atLimit },
  { value: 'file', label: 'Upload file (coming soon)', icon: 'upload', disabled: true },
  { value: 'link', label: 'Add link (coming soon)', icon: 'link', disabled: true },
])
const trigger = () => dropdown.value?.$el.querySelector<HTMLElement>('[role="button"]')
function items() {
  const id = trigger()?.getAttribute('aria-controls')
  return id ? [...(document.getElementById(id)?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])] : []
}
async function close(focus = true) {
  if (trigger()?.getAttribute('aria-expanded') === 'true') trigger()?.click()
  await nextTick()
  if (focus) trigger()?.focus({ preventScroll: true })
}
async function select(value: string) {
  if (props.disabled || value !== 'conversation' || props.atLimit) return
  await close(false)
  emit('conversation')
}
async function triggerKey(event: KeyboardEvent) {
  if (props.disabled) return
  const expanded = trigger()?.getAttribute('aria-expanded') === 'true'
  if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); await close(); return }
  if (!['ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) return
  event.preventDefault(); event.stopPropagation()
  if (expanded && ['Enter', ' '].includes(event.key)) { await close(); return }
  if (!expanded) trigger()?.click()
  await nextTick()
  const available = items()
  available[event.key === 'ArrowUp' ? available.length - 1 : 0]?.focus()
}
async function menuKey(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); await close(); return }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const available = items()
  const current = available.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length
  available[next]?.focus()
}
watch([dropdown, () => props.disabled], () => {
  trigger()?.setAttribute('aria-disabled', String(props.disabled))
  trigger()?.setAttribute('tabindex', props.disabled ? '-1' : '0')
  if (props.disabled) void close(false)
}, { flush: 'post' })
</script>

<template>
  <NyxDropdown ref="dropdown" class="prompt-asset-menu" :class="{ 'prompt-asset-menu--disabled': disabled }" :inert="disabled || undefined" :position="NyxPosition.TopLeft" :size="NyxSize.Small" @keydown.capture="triggerKey">
    <NyxIcon name="plus" :size="20" aria-hidden="true" /><span class="sr-only">Add asset</span>
    <template #dropdown>
      <div class="prompt-asset-menu__options" @keydown.stop="menuKey">
        <NyxDropdownItem v-for="option in options" :key="option.value" :option="option" :size="NyxSize.Small" @click="select(option.value)" />
        <p v-if="atLimit" class="prompt-asset-menu__limit" role="status">Up to ten conversations per prompt.</p>
      </div>
    </template>
  </NyxDropdown>
</template>

<style scoped lang="scss">
.prompt-asset-menu {
  &--disabled { opacity: .5; }
  &__options { min-width: 220px; padding: 4px; background: var(--nyx-c-bg-soft); color: var(--viewer-ink); .nyx-dropdown-item { width: 100%; color: inherit; text-align: left; } }
  &__limit { padding: 8px 12px; max-width: 28ch; font-size: 11px; color: var(--nyx-c-text-2); }
}
</style>
