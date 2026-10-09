<script setup lang="ts">
import { NyxActionItem, NyxButton, NyxIcon } from 'nyx-kit/components'
import { NyxSize, NyxTheme, NyxVariant } from 'nyx-kit/types'
import PageHeading from './PageHeading.vue'
import ServerConnection from './ServerConnection.vue'
import ChatGPTSettings from './ChatGPTSettings.vue'
defineProps<{ localServer: boolean; isDark: boolean; loading: boolean; forgetting: boolean; canForget: boolean }>()
defineEmits<{ back: []; theme: []; import: []; forget: []; deleted: [] }>()
</script>

<template>
  <section class="settings-page" aria-labelledby="settings-title">
    <div class="settings-page__content app-page">
      <PageHeading id="settings-title" title="Settings" @back="$emit('back')" />
      <div class="settings-page__actions">
        <NyxActionItem title="Appearance" :theme="NyxTheme.Info">
          Choose a light or dark appearance. Echo remembers your preference.
          <template #action><NyxButton :variant="NyxVariant.Soft" :size="NyxSize.Small" :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'" @click="$emit('theme')"><NyxIcon :name="isDark ? 'sun' : 'moon'" :size="17" aria-hidden="true" />{{ isDark ? 'Light mode' : 'Dark mode' }}</NyxButton></template>
        </NyxActionItem>
        <NyxActionItem title="Import export" :theme="NyxTheme.Info">
          {{ localServer ? 'Add a JSON export ZIP or extracted folder to your library. Echo checks for existing history before adding new messages. Your source files stay untouched.' : 'Open an extracted JSON export folder. A successful import replaces the archive saved in this browser. Your source files stay untouched.' }}
          <template #action><NyxButton :variant="NyxVariant.Soft" :size="NyxSize.Small" :disabled="loading || forgetting" @click="$emit('import')">{{ localServer ? 'Import export' : 'Open folder' }}</NyxButton></template>
        </NyxActionItem>
        <NyxActionItem v-if="!localServer && canForget" title="Forget archive" :theme="NyxTheme.Info">
          Remove the archive saved in this browser and close its conversations. Your original export stays untouched.
          <template #action><NyxButton :variant="NyxVariant.Soft" :size="NyxSize.Small" :loading="forgetting" @click="$emit('forget')">Forget archive</NyxButton></template>
        </NyxActionItem>
        <ChatGPTSettings />
        <ServerConnection v-if="localServer" @deleted="$emit('deleted')" />
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.settings-page {
  width: 100%; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  &__content { overflow: visible; }
  &__actions { display: grid; gap: var(--nyx-gap-xl); }
}
</style>
