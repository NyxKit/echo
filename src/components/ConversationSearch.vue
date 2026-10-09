<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NyxCommandPalette } from 'nyx-kit/components'
import { NyxCommandPaletteViewportMode, type NyxCommandPaletteGroup, type NyxCommandPaletteItem, type NyxCommandPaletteSelectEvent } from 'nyx-kit/types'
import type { Conversation } from '../lib/archive'
import { conversationDateLabel, newestConversationsFirst } from '../lib/conversation-order'

interface ConversationResult extends NyxCommandPaletteItem { date: string }
const props = defineProps<{ conversations: readonly Conversation[]; loading: boolean; activeId: string }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ select: [id: string] }>()
const query = ref('')
let pendingSelection: AbortController | undefined
watch(open, value => {
  if (value) { pendingSelection?.abort(); query.value = '' }
}, { flush: 'sync' })
onBeforeUnmount(() => pendingSelection?.abort())

const groups = computed<NyxCommandPaletteGroup<ConversationResult>[]>(() => {
  // Search every summary, including conversations outside the sidebar's visible
  // folder and rendering limit. No message bodies or extra API calls are needed.
  const ordered = [...props.conversations].sort(newestConversationsFirst)
  return [{ id: 'inbox', label: 'Inbox' }, { id: 'requests', label: 'Message requests' }].map(group => ({
    ...group,
    items: ordered.filter(conversation => (conversation.category === 'Requests') === (group.id === 'requests')).map(conversation => ({
      id: conversation.id, label: conversation.title || 'Untitled conversation',
      description: conversation.participants.join(', '), keywords: conversation.participants,
      icon: 'messages-square', date: conversationDateLabel(conversation),
    })),
  }))
})

function select({ item, originalEvent }: NyxCommandPaletteSelectEvent<ConversationResult>) {
  pendingSelection?.abort()
  const dialog = originalEvent.target instanceof Element ? originalEvent.target.closest('dialog') : null
  const waitForClose = !!dialog?.open
  // Let the kit finish closing its modal before the destination heading receives
  // focus. Native close fires after its focus/scroll cleanup, without a timer.
  if (dialog && waitForClose) {
    pendingSelection = new AbortController()
    dialog.addEventListener('close', () => emit('select', item.id), { once: true, signal: pendingSelection.signal })
  }
  open.value = false
  if (!waitForClose) emit('select', item.id)
}
</script>

<template>
  <NyxCommandPalette v-model:open="open" v-model:search-term="query" :model-value="activeId || undefined" :groups="groups" :loading="loading"
    :viewport-mode="NyxCommandPaletteViewportMode.WhileSearching" label="Search conversations" placeholder="Search names or participants…"
    loading-text="Loading conversations…" empty-text="No conversations match. Try another name." closeable close-label="Close conversation search" @select="select">
    <template #item-trailing="{ item }"><span class="conversation-search__date">{{ item.date }}</span></template>
    <template #footer>Search names and participants in Inbox and message requests.</template>
  </NyxCommandPalette>
</template>

<style scoped lang="scss">
.conversation-search__date { color: var(--nyx-c-text-2); font-size: var(--nyx-font-size-xs); white-space: nowrap; }
</style>
