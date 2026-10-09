<script setup lang="ts" generic="T extends string">
import { nextTick, ref } from 'vue'
import { NyxDropdown, NyxDropdownItem, NyxIcon } from 'nyx-kit/components'
import { NyxSize } from 'nyx-kit/types'

defineProps<{ label: string; options: readonly { value: T; label: string }[]; actions?: readonly { value: string; label: string; icon?: string; disabled?: boolean }[] }>()
const emit = defineEmits<{ action: [value: string] }>()
const selected = defineModel<T>({ required: true })
const dropdown = ref<{ $el: HTMLElement }>()
function trigger(): HTMLElement | undefined { return dropdown.value?.$el.querySelector<HTMLElement>('[role="button"]') ?? undefined }
function items(): HTMLElement[] {
  const id = trigger()?.getAttribute('aria-controls')
  return id ? Array.from(document.getElementById(id)?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []) : []
}
async function close() {
  if (trigger()?.getAttribute('aria-expanded') === 'true') trigger()?.click()
  await nextTick()
  trigger()?.focus()
}
async function select(value: T) { selected.value = value; await close() }
async function runAction(value: string) { await close(); emit('action', value) }
async function onTriggerKey(event: KeyboardEvent) {
  const expanded = trigger()?.getAttribute('aria-expanded') === 'true'
  if (event.key === 'Escape' && expanded) {
    event.preventDefault()
    event.stopPropagation()
    trigger()?.click()
    await nextTick()
    trigger()?.focus()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  if (!expanded) trigger()?.click()
  await nextTick()
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  const options = items()
  options[event.key === 'ArrowUp' ? options.length - 1 : 0]?.focus()
}
async function onMenuKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    trigger()?.click()
    await nextTick()
    trigger()?.focus()
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const options = items()
    const current = options.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
    options[next]?.focus()
  } else if (event.key === 'Tab') {
    event.preventDefault()
    trigger()?.click()
    await nextTick()
    trigger()?.focus()
  }
}
</script>

<template>
  <NyxDropdown ref="dropdown" class="filter-menu" :size="NyxSize.Small" @keydown.capture="onTriggerKey">
    <NyxIcon name="ellipsis" :size="20" aria-hidden="true" /><span class="sr-only">{{ label }}</span>
    <template #dropdown>
      <div class="filter-menu__menu" @keydown.stop="onMenuKey">
        <NyxDropdownItem v-for="option in options" :key="option.value" class="filter-menu__item" :option="{ ...option, icon: selected === option.value ? 'circle-check' : 'circle' }" :size="NyxSize.Small" role="menuitemradio" :aria-checked="selected === option.value" @click="select(option.value)" />
        <template v-if="actions?.length">
          <div class="filter-menu__separator" role="separator" />
          <NyxDropdownItem v-for="action in actions" :key="action.value" class="filter-menu__item" :option="action" :size="NyxSize.Small" @click="runAction(action.value)" />
        </template>
      </div>
    </template>
  </NyxDropdown>
</template>
