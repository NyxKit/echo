<script setup lang="ts">
import { ref } from 'vue'
import { NyxButton, NyxIcon, NyxTooltip } from 'nyx-kit/components'
import { NyxPosition, NyxSize, NyxVariant } from 'nyx-kit/types'

withDefaults(defineProps<{ label?: string }>(), { label: 'Go to original message' })
const emit = defineEmits<{ click: [] }>()
const tooltip = ref(false)
function dismissTooltip(event: KeyboardEvent) {
  if (!tooltip.value) return
  event.preventDefault()
  event.stopPropagation()
  tooltip.value = false
}
</script>

<template>
  <NyxTooltip v-model="tooltip" class="message-jump" text="View message" :position="NyxPosition.TopRight" :size="NyxSize.Small" @focusin="tooltip = true" @focusout="tooltip = false" @keydown.esc="dismissTooltip">
    <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" :aria-label="label" @click="emit('click')"><NyxIcon name="corner-up-left" :size="16" aria-hidden="true" /></NyxButton>
  </NyxTooltip>
</template>
