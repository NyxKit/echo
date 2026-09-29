<script setup lang="ts">
import { computed } from 'vue'
import { emojiHearts } from '../lib/message-display'
const props = defineProps<{ text: string; query?: string }>()
const parts = computed(() => {
  const query = emojiHearts(props.query?.trim() ?? '')
  if (!query) return [{ text: emojiHearts(props.text), match: false }]
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return emojiHearts(props.text).split(new RegExp(`(${escaped})`, 'gi')).map((text, index) => ({ text, match: index % 2 === 1 }))
})
</script>

<template><span><template v-for="(part, index) in parts" :key="index"><mark v-if="part.match">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span></template>
