<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NyxButton, NyxDropdown, NyxIcon, NyxSelect } from 'nyx-kit/components'
import { NyxPosition, NyxSize, NyxVariant } from 'nyx-kit/types'
import type { Conversation } from '../lib/archive'
import { analysisPreferences } from '../stores/analysis-preferences'
import { assetScopes, conversationAssetLimit, type AssetScope, type ConversationAssetChoice } from '../../shared/prompt-assets.mjs'
import { contextLabel } from '../../shared/context-windows.mjs'

const props = defineProps<{ conversations: Conversation[]; activeId: string; disabled: boolean }>()
const assets = defineModel<ConversationAssetChoice[]>({ required: true })
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ added: []; close: [] }>()
const picked = ref('')
const windowScope = ref<AssetScope>('week')
const conversationSelect = ref<{ $el: HTMLElement }>()
const windowSelect = ref<{ $el: HTMLElement }>()
const available = computed(() => props.conversations.filter(conversation => conversation.id !== props.activeId && !assets.value.some(asset => asset.conversationId === conversation.id)))
const options = computed(() => available.value.map(conversation => {
  let label = `${conversation.title} · ${conversation.participants.join(', ') || conversation.category}`
  const identical = props.conversations.filter(item => item.id !== props.activeId && item.title === conversation.title && item.participants.join(', ') === conversation.participants.join(', '))
  if (identical.length > 1) label += ` (${identical.indexOf(conversation) + 1})`
  return { value: conversation.id, label }
}))
const windows = assetScopes.map(value => ({ value, label: contextLabel(value) }))
function title(id: string) {
  const conversation = props.conversations.find(value => value.id === id)
  if (!conversation) return 'Unavailable conversation'
  const identical = props.conversations.filter(value => value.title === conversation.title)
  return identical.length > 1 ? `${conversation.title} (${identical.indexOf(conversation) + 1})` : conversation.title
}
function label(control: { $el: HTMLElement } | undefined, name: string) {
  control?.$el.querySelector('[role="combobox"]')?.setAttribute('aria-label', name)
  control?.$el.querySelector('select')?.setAttribute('aria-hidden', 'true')
}
watch(conversationSelect, value => label(value, 'Conversation to attach'), { flush: 'post' })
watch(windowSelect, value => label(value, 'Attached context window'), { flush: 'post' })
watch(open, async value => {
  if (!value) return
  picked.value = ''
  windowScope.value = assetScopes.includes(analysisPreferences.defaultContext as AssetScope) ? analysisPreferences.defaultContext as AssetScope : 'week'
  await nextTick()
  // Let the opening click finish before the kit's outside-click listener sees
  // a newly mounted select. Otherwise that same click immediately closes it.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  if (!open.value || props.disabled) return
  const control = conversationSelect.value?.$el.querySelector<HTMLElement>('[role="combobox"]')
  control?.focus()
  control?.click()
})
function close() { open.value = false; emit('close') }
function add() {
  if (props.disabled || assets.value.length >= conversationAssetLimit || !available.value.some(value => value.id === picked.value)) return
  assets.value = [...assets.value, { kind: 'conversation', id: crypto.randomUUID(), conversationId: picked.value, scope: windowScope.value }]
  open.value = false; emit('added')
}
function changeWindow(id: string, scope: string) {
  if (!props.disabled && assetScopes.includes(scope as AssetScope)) assets.value = assets.value.map(asset => asset.id === id ? { ...asset, scope: scope as AssetScope } : asset)
}
function remove(id: string) { if (!props.disabled) assets.value = assets.value.filter(asset => asset.id !== id) }
</script>

<template>
  <div v-if="open || assets.length" class="prompt-assets" :inert="disabled || undefined" @keydown.esc.stop.prevent="close">
    <ul v-if="assets.length" class="prompt-assets__list" aria-label="Attached conversations">
      <li v-for="asset in assets" :key="asset.id" class="prompt-assets__chip">
        <NyxIcon name="messages-square" :size="16" aria-hidden="true" />
        <div class="prompt-assets__source"><span :title="title(asset.conversationId)">{{ title(asset.conversationId) }}</span>
          <NyxDropdown :options="windows.map(option => ({ ...option, icon: option.value === asset.scope ? 'check' : undefined }))" :position="NyxPosition.Top" :size="NyxSize.Small" @select="changeWindow(asset.id, $event.value)" @keydown.esc.stop>
            <span class="sr-only">Context for {{ title(asset.conversationId) }}: </span>{{ contextLabel(asset.scope) }}<NyxIcon name="chevron-down" :size="12" />
          </NyxDropdown>
        </div>
        <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" :disabled="disabled" :aria-label="`Remove attached conversation ${title(asset.conversationId)}`" @click="remove(asset.id)"><NyxIcon name="x" :size="14" /></NyxButton>
      </li>
    </ul>
    <section v-if="open" id="prompt-asset-picker" class="prompt-assets__picker" aria-label="Add conversation context">
      <div class="prompt-assets__heading"><h3>Add conversation context</h3><NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" aria-label="Close asset picker" @click="close"><NyxIcon name="x" :size="16" /></NyxButton></div>
      <template v-if="available.length && assets.length < conversationAssetLimit">
        <label for="prompt-asset-conversation">Conversation</label>
        <NyxSelect ref="conversationSelect" id="prompt-asset-conversation" v-model="picked" :options="options" placeholder="Find a conversation…" :size="NyxSize.Small" :disabled="disabled"><template #empty>No matching conversations.</template></NyxSelect>
        <label for="prompt-asset-window">Context window</label>
        <NyxSelect ref="windowSelect" id="prompt-asset-window" v-model="windowScope" :options="windows" :size="NyxSize.Small" :disabled="disabled" />
        <p>Ends at this conversation’s latest archived message. Text only.</p>
        <NyxButton class="prompt-assets__add" :variant="NyxVariant.Soft" :size="NyxSize.Small" :disabled="disabled || !available.some(value => value.id === picked)" @click="add">Add conversation</NyxButton>
      </template>
      <p v-else role="status">{{ assets.length >= conversationAssetLimit ? 'Up to ten conversations can be attached to one prompt. Remove one to choose another.' : 'No other conversations available. Each conversation can be attached once per prompt.' }}</p>
    </section>
  </div>
</template>

<style scoped lang="scss">
.prompt-assets {
  padding: 12px 12px 0;
  &__list { display: flex; flex-wrap: wrap; gap: var(--nyx-gap-sm); max-height: 160px; overflow: auto; }
  &__chip { display: flex; align-items: center; gap: var(--nyx-gap-sm); min-width: 0; max-width: 100%; padding: 6px 4px 6px 10px; border: 1px solid var(--nyx-c-divider-light); border-radius: var(--nyx-radius-lg); > .nyx-icon, > .nyx-button { flex-shrink: 0; } > .nyx-button { padding: 6px; } }
  &__source { min-width: 0; font-size: 12px; > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; max-width: 28ch; } :deep(.nyx-dropdown__trigger) { display: flex; align-items: center; gap: 4px; padding: 0; font-size: 11px; color: var(--nyx-c-text-2); } }
  &__picker { display: grid; gap: var(--nyx-gap-sm); padding: 4px 4px 12px; label { font-size: 12px; font-weight: 600; } p { font-size: 11px; line-height: 1.5; color: var(--nyx-c-text-2); } .nyx-select { min-width: 0; width: 100%; } }
  &__list + &__picker { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--nyx-c-divider-light); }
  &__heading { display: flex; justify-content: space-between; align-items: center; h3 { font-size: 13px; font-weight: 600; } }
  &__add { justify-self: start; margin-top: 4px; }
}
</style>
