<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NyxButton, NyxCommandPalette, NyxDropdown, NyxIcon, NyxModal, NyxSelect } from 'nyx-kit/components'
import { NyxCommandPaletteViewportMode, NyxPosition, NyxSize, NyxVariant, type NyxCommandPaletteGroup, type NyxCommandPaletteItem } from 'nyx-kit/types'
import type { Conversation } from '../lib/archive'
import { analysisPreferences } from '../stores/analysis-preferences'
import { assetScopes, conversationAssetLimit, type AssetScope, type ConversationAssetChoice } from '../../shared/prompt-assets.mjs'
import { contextLabel } from '../../shared/context-windows.mjs'
import { conversationDateLabel, newestConversationsFirst } from '../lib/conversation-order'

const props = defineProps<{ conversations: Conversation[]; activeId: string; disabled: boolean }>()
const assets = defineModel<ConversationAssetChoice[]>({ required: true })
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ added: []; close: [] }>()
const picked = ref('')
const query = ref('')
const windowScope = ref<AssetScope>('week')
const modal = ref<{ $el: HTMLDialogElement }>()
const palette = ref<{ focus: () => void }>()
const windowSelect = ref<{ $el: HTMLElement }>()
let added = false
const available = computed(() => props.conversations.filter(conversation => conversation.id !== props.activeId && !assets.value.some(asset => asset.conversationId === conversation.id)))
interface ConversationChoice extends NyxCommandPaletteItem { date: string; unavailable: string }
const titles = computed(() => {
  const grouped = new Map<string, Conversation[]>()
  for (const conversation of props.conversations) {
    if (!grouped.has(conversation.title)) grouped.set(conversation.title, [])
    grouped.get(conversation.title)!.push(conversation)
  }
  return new Map([...grouped].flatMap(([title, conversations]) => conversations.map((conversation, index) => [conversation.id, conversations.length > 1 ? `${title || 'Untitled conversation'} (${index + 1})` : title || 'Untitled conversation'] as const)))
})
const groups = computed<NyxCommandPaletteGroup<ConversationChoice>[]>(() => [{ id: 'conversations', items: [...props.conversations].sort(newestConversationsFirst).map(conversation => {
  const unavailable = conversation.id === props.activeId ? 'Current conversation' : assets.value.some(asset => asset.conversationId === conversation.id) ? 'Already attached' : ''
  return { id: conversation.id, label: title(conversation.id), description: conversation.participants.join(', '), keywords: conversation.participants,
    icon: 'messages-square', date: conversationDateLabel(conversation) || 'No date', unavailable, disabled: !!unavailable || props.disabled || assets.value.length >= conversationAssetLimit }
}) }])
const windows = assetScopes.map(value => ({ value, label: contextLabel(value) }))
function title(id: string) {
  return titles.value.get(id) ?? 'Unavailable conversation'
}
function label(control: { $el: HTMLElement } | undefined, name: string) {
  control?.$el.querySelector('[role="combobox"]')?.setAttribute('aria-label', name)
  control?.$el.querySelector('select')?.setAttribute('aria-hidden', 'true')
}
watch(windowSelect, value => label(value, 'Attached context window'), { flush: 'post' })
watch(open, async value => {
  if (!value) {
    const confirmed = added; added = false
    await nextTick()
    if (confirmed) emit('added')
    else emit('close')
    return
  }
  picked.value = ''
  query.value = ''
  windowScope.value = assetScopes.includes(analysisPreferences.defaultContext as AssetScope) ? analysisPreferences.defaultContext as AssetScope : 'week'
  await nextTick()
  if (!open.value || props.disabled) return
  modal.value?.$el.querySelector('.nyx-modal__close')?.setAttribute('aria-label', 'Close conversation picker')
  palette.value?.focus()
}, { flush: 'post' })
function close() { open.value = false }
function modalKey(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.stopPropagation()
  if (event.defaultPrevented) return
  event.preventDefault()
  close()
}
function modalEscapeFallback(event: KeyboardEvent) {
  if (open.value && modal.value?.$el.open && !modal.value.$el.contains(event.target as Node)) modalKey(event)
}
onMounted(() => window.addEventListener('keydown', modalEscapeFallback, true))
onUnmounted(() => window.removeEventListener('keydown', modalEscapeFallback, true))
function windowKey(event: KeyboardEvent) {
  if (windowSelect.value?.$el.querySelector('[role="combobox"]')?.getAttribute('aria-expanded') === 'true') {
    // The kit closes this select on keyup; keep its first Escape in the modal.
    event.preventDefault()
    event.stopPropagation()
  }
}
function add() {
  if (props.disabled || assets.value.length >= conversationAssetLimit || !available.value.some(value => value.id === picked.value)) return
  assets.value = [...assets.value, { kind: 'conversation', id: crypto.randomUUID(), conversationId: picked.value, scope: windowScope.value }]
  added = true; open.value = false
}
function changeWindow(id: string, scope: string) {
  if (!props.disabled && assetScopes.includes(scope as AssetScope)) assets.value = assets.value.map(asset => asset.id === id ? { ...asset, scope: scope as AssetScope } : asset)
}
function remove(id: string) { if (!props.disabled) assets.value = assets.value.filter(asset => asset.id !== id) }
</script>

<template>
  <div v-if="assets.length" class="prompt-assets" :inert="disabled || undefined">
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
  </div>
  <NyxModal ref="modal" v-model="open" title="Add conversation context" custom-class="prompt-conversation-picker" @keydown="modalKey" @cancel.stop>
    <NyxCommandPalette v-if="open" ref="palette" v-model="picked" v-model:search-term="query" :groups="groups" inline :viewport-mode="NyxCommandPaletteViewportMode.Always" :disabled="disabled" label="Search conversations to attach" placeholder="Search names or participants…" empty-text="No matching conversations." @close="close">
      <template #item-trailing="{ item }"><span class="prompt-conversation-picker__detail">{{ item.unavailable || item.date }}</span></template>
    </NyxCommandPalette>
    <template #footer>
      <div class="prompt-conversation-picker__footer">
        <p v-if="!available.length || assets.length >= conversationAssetLimit" role="status">{{ assets.length >= conversationAssetLimit ? 'Up to ten conversations can be attached to one prompt. Remove one to choose another.' : 'No other conversations available. Each conversation can be attached once per prompt.' }}</p>
        <p v-if="picked" class="prompt-conversation-picker__selection">Selected: {{ title(picked) }}</p>
        <div class="prompt-conversation-picker__window"><label for="prompt-asset-window">Context window</label><NyxSelect ref="windowSelect" id="prompt-asset-window" v-model="windowScope" :options="windows" :size="NyxSize.Small" :disabled="disabled" @keydown.esc="windowKey" /></div>
        <p>Ends at this conversation’s latest archived message. Text only.</p>
        <div class="prompt-conversation-picker__actions"><NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" @click="close">Cancel</NyxButton><NyxButton :variant="NyxVariant.Soft" :size="NyxSize.Small" :disabled="disabled || assets.length >= conversationAssetLimit || !available.some(value => value.id === picked)" @click="add">Add conversation</NyxButton></div>
      </div>
    </template>
  </NyxModal>
</template>

<style scoped lang="scss">
.prompt-assets {
  padding: 12px 12px 0;
  &__list { display: flex; flex-wrap: wrap; gap: var(--nyx-gap-sm); max-height: 160px; overflow: auto; }
  &__chip { display: flex; align-items: center; gap: var(--nyx-gap-sm); min-width: 0; max-width: 100%; padding: 6px 4px 6px 10px; border: 1px solid var(--nyx-c-divider-light); border-radius: var(--nyx-radius-lg); > .nyx-icon, > .nyx-button { flex-shrink: 0; } > .nyx-button { padding: 6px; } }
  &__source { min-width: 0; font-size: 12px; > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; max-width: 28ch; } :deep(.nyx-dropdown__trigger) { display: flex; align-items: center; gap: 4px; padding: 0; font-size: 11px; color: var(--nyx-c-text-2); } }
}
.prompt-conversation-picker {
  &__detail { flex-shrink: 0; color: var(--nyx-c-text-2); font-size: var(--nyx-font-size-xs); }
  &__footer { display: grid; gap: var(--nyx-gap-sm); width: 100%; min-width: 0; p { color: var(--nyx-c-text-2); font-size: 11px; line-height: 1.5; } }
  &__selection { overflow-wrap: anywhere; }
  &__window { display: grid; gap: var(--nyx-gap-sm); label { font-size: 12px; font-weight: 600; } .nyx-select { width: 100%; min-width: 0; } }
  &__actions { display: flex; justify-content: flex-end; gap: var(--nyx-gap-sm); margin-top: 4px; }
}
</style>

<style lang="scss">
.prompt-conversation-picker.nyx-modal {
  --nyx-width-modal: 42rem;
  color: var(--viewer-ink);
  .nyx-modal__header h1 { font-size: 17px; }
  .nyx-modal__surface { display: flex; flex-direction: column; max-height: calc(100dvh - 32px); }
  .nyx-modal__body { display: flex; flex-direction: column; min-height: 0; padding: 0; overflow: hidden; }
  .nyx-command-palette { flex: 1; min-height: 0; border: 0; border-radius: 0; max-height: min(42dvh, 28rem); }
  .nyx-modal__footer { flex-shrink: 0; border-top: 1px solid var(--nyx-c-divider-light); }
  @media (max-width: 600px) {
    .nyx-modal__header, .nyx-modal__footer { padding: 12px 16px; }
    .prompt-conversation-picker__detail { max-width: 13ch; white-space: normal; text-align: right; }
  }
}
</style>
