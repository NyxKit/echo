<script setup lang="ts">
import { computed } from 'vue'
import { NyxButton, NyxMarkdown } from 'nyx-kit/components'
import { NyxSize, NyxVariant, type NyxMarkdownInlineRule } from 'nyx-kit/types'
import type { Conversation } from '../lib/archive'
import { messageReference } from '../lib/analysis-context'
import { assetCitation, type ConversationPromptAsset } from '../../shared/prompt-assets.mjs'
import { referenceExists } from '../../shared/analysis-policy.mjs'

const props = defineProps<{ text: string; conversation: Conversation; referenceMap?: Record<string, string>; assets?: ConversationPromptAsset[] }>()
const emit = defineEmits<{ jump: [index: number]; jumpAsset: [target: { conversationId: string; messageId: string }] }>()
const references = computed(() => {
  if (props.referenceMap) {
    const indexes = new Map(props.conversation.messages.map((message, index) => [message.id, index]))
    return new Map(Object.entries(props.referenceMap).flatMap(([reference,id]) => indexes.has(id) ? [[reference, indexes.get(id)!] as const] : []))
  }
  return new Map(props.conversation.messages.map((message, index) => [messageReference(message), index]))
})
interface Citation { index?: number; conversationId?: string; messageId?: string; title?: string; reference?: string }
const assetReferences = computed(() => new Map((props.assets ?? []).flatMap(asset => {
  let parts: unknown[]
  try { parts = asset.sourceParts.map(part => JSON.parse(part)) } catch { return [] }
  return Object.entries(asset.referenceMap).flatMap(([reference, messageId]) => referenceExists(reference, parts)
    ? [[assetCitation(asset.id, reference), { conversationId: asset.conversationId, messageId, title: asset.title, reference }]] as const : [])
})))
const citationRules: NyxMarkdownInlineRule<Citation>[] = [{
  name: 'message-citation',
  match(source, offset) {
    if (!source.startsWith('[[', offset)) return null
    const match = /^\[\[((?:a[a-f0-9-]{36}:)?p[1-9]\d*:m[1-9]\d*)\]\]/.exec(source.slice(offset))
    if (!match) return null
    const asset = assetReferences.value.get(match[1])
    if (asset) return { length: match[0].length, value: asset }
    const index = references.value.get(match[1])
    return index === undefined ? null : { length: match[0].length, value: { index } }
  },
}]
function jump(value: Citation) {
  if (value.conversationId && value.messageId) emit('jumpAsset', { conversationId: value.conversationId, messageId: value.messageId })
  else if (value.index !== undefined) emit('jump', value.index)
}
const citationLabel = (value: Citation) => value.conversationId ? `${value.title} (${value.reference})` : `Message ${(value.index ?? 0) + 1}`
const citationAria = (value: Citation) => value.conversationId ? `View cited message in ${value.title} (${value.reference})` : `View cited message ${(value.index ?? 0) + 1}`
</script>

<template>
  <NyxMarkdown class="analysis-answer" :content="text" :inline-rules="citationRules" :heading-offset="2" :size="NyxSize.Small">
    <template #inline="{ value }">
      <NyxButton class="analysis-answer__citation" type="button" :variant="NyxVariant.Subtle" :size="NyxSize.Small" :aria-label="citationAria(value)" @click="jump(value)">{{ citationLabel(value) }}</NyxButton>
    </template>
  </NyxMarkdown>
</template>
