<script setup lang="ts">
import { computed } from 'vue'
import { NyxButton, NyxMarkdown } from 'nyx-kit/components'
import { NyxSize, NyxVariant, type NyxMarkdownInlineRule } from 'nyx-kit/types'
import type { Conversation } from '../lib/archive'
import { messageReference } from '../lib/analysis-context'

const props = defineProps<{ text: string; conversation: Conversation; referenceMap?: Record<string, string> }>()
const emit = defineEmits<{ jump: [index: number] }>()
const references = computed(() => {
  if (props.referenceMap) {
    const indexes = new Map(props.conversation.messages.map((message, index) => [message.id, index]))
    return new Map(Object.entries(props.referenceMap).flatMap(([reference,id]) => indexes.has(id) ? [[reference, indexes.get(id)!] as const] : []))
  }
  return new Map(props.conversation.messages.map((message, index) => [messageReference(message), index]))
})
const citationRules: NyxMarkdownInlineRule<{ index: number }>[] = [{
  name: 'message-citation',
  match(source, offset) {
    if (!source.startsWith('[[p', offset)) return null
    const match = /^\[\[(p[1-9]\d*:m[1-9]\d*)\]\]/.exec(source.slice(offset))
    if (!match) return null
    const index = references.value.get(match[1])
    return index === undefined ? null : { length: match[0].length, value: { index } }
  },
}]
</script>

<template>
  <NyxMarkdown class="analysis-answer" :content="text" :inline-rules="citationRules" :heading-offset="2" :size="NyxSize.Small">
    <template #inline="{ value }">
      <NyxButton class="analysis-answer__citation" type="button" :variant="NyxVariant.Subtle" :size="NyxSize.Small" :aria-label="`View cited message ${value.index + 1}`" @click="emit('jump', value.index)">Message {{ value.index + 1 }}</NyxButton>
    </template>
  </NyxMarkdown>
</template>
