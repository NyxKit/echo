<script setup lang="ts">
import { NyxButton, NyxIcon } from 'nyx-kit/components'
import { NyxSize, NyxVariant } from 'nyx-kit/types'
defineProps<{ title: string; id: string }>()
defineEmits<{ back: [] }>()
</script>

<template>
  <header class="page-heading">
    <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" aria-label="Back to conversations" @click="$emit('back')"><NyxIcon name="arrow-left" :size="20" aria-hidden="true" /></NyxButton>
    <h2 :id="id" tabindex="-1">{{ title }}</h2>
  </header>
</template>

<style scoped lang="scss">
.page-heading {
  display: flex; align-items: center; gap: var(--nyx-gap-lg); margin-bottom: calc(var(--nyx-gap-xl) * 2);
  h2 { margin: 0; font-size: 1.5rem; font-weight: 650; line-height: 1.3; }
  h2:focus { outline: none; }
  > .nyx-button { flex-shrink: 0; }
}
</style>
