<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NyxButton, NyxCheckbox, NyxSelect } from 'nyx-kit/components'
import { NyxSize, NyxVariant } from 'nyx-kit/types'
import ChatGPTConnection from './ChatGPTConnection.vue'
import { useChatGPTConnection } from '../composables/useChatGPTConnection'
import { analysisPreferences } from '../stores/analysis-preferences'
import { viewerStore } from '../stores/viewer'
import { contextChoices, contextLabel, isTimeScope } from '../../shared/context-windows.mjs'
const { models, modelsLoading, modelError, model, connected, refreshModels } = useChatGPTConnection()
const developerBuild = import.meta.env.DEV
const modelSelect = ref<{ $el: HTMLElement }>()
const contextSelect = ref<{ $el: HTMLElement }>()
const defaults = computed(() => contextChoices.filter(value => value !== 'selected').map(value => ({ value, label: isTimeScope(value) ? `${contextLabel(value)} / ${contextLabel(value, true).toLowerCase()}` : contextLabel(value) })))
function label(control: { $el: HTMLElement } | undefined, value: string) {
  control?.$el.querySelector('[role="combobox"]')?.setAttribute('aria-label', value)
  control?.$el.querySelector('select')?.setAttribute('aria-hidden', 'true')
}
watch(modelSelect, value => label(value, 'Default model'), { flush: 'post' })
watch(contextSelect, value => label(value, 'Default context'), { flush: 'post' })
</script>

<template>
  <section class="chatgpt-settings" aria-label="ChatGPT settings">
    <ChatGPTConnection />
    <div class="chatgpt-settings__field">
      <label for="default-context">Default context</label>
      <NyxSelect ref="contextSelect" id="default-context" v-model="analysisPreferences.defaultContext" :options="defaults" :size="NyxSize.Small" />
      <p>Applies to new discussions. Last windows end at the latest message in the archive. With selected messages, each window is centered when possible, then shifted at archive boundaries to include the chosen duration. Shorter archives include all dated history. Overlapping windows are merged.</p>
      <p>A week is 7 days, a month 30 days, 3 months 90 days, 6 months 180 days, and a year 365 days. Selected messages without timestamps are included without a surrounding window. Choose Only selected messages in the composer when messages are attached.</p>
    </div>
    <div class="chatgpt-settings__field">
      <label for="default-model">Default model</label>
      <NyxSelect v-if="models.length" ref="modelSelect" id="default-model" v-model="analysisPreferences.defaultModel" :options="models" :size="NyxSize.Small" />
      <p v-if="modelsLoading" role="status">Loading available models…</p>
      <p v-else-if="!connected">Connect ChatGPT to choose a model.</p>
      <p v-if="modelError" role="alert">{{ modelError }}</p>
      <p v-else-if="models.length && !model" role="alert">Your default model is unavailable. Choose an available model.</p>
      <NyxButton v-if="connected" :variant="NyxVariant.Subtle" :size="NyxSize.Small" :disabled="modelsLoading" @click="refreshModels">Refresh models</NyxButton>
    </div>
    <div class="chatgpt-settings__field">
      <h3>Context and sharing</h3>
      <p>Sending shares the chosen conversation context, your question, and earlier questions and answers in this discussion with OpenAI. Selected messages are the focus.</p>
      <p>In the library, every Send also includes your latest saved conversation note. Groups automatically include available notes from verified participants’ individual conversations. Only those notes are inherited, without their messages, media, or AI discussions. Edit individual context in its own conversation; the group’s note remains separate.</p>
      <p>Editing or saving a note sends nothing to OpenAI. Changes and cleared notes apply on your next Send, including existing discussions. Earlier versions remain in accepted discussion history and may be sent again as historical context. Removing a note does not erase earlier turns or retract information already shared with OpenAI.</p>
      <p>Each prompt also includes your device’s current date, time, and timezone so Echo can interpret relative dates and waiting time when relevant. Earlier prompts keep their original times.</p>
      <p>After the first response, your first prompt is sent once more to create a discussion subject. This runs in the background and keeps any subject you set yourself.</p>
      <p>The context choice stays fixed after the first successful response. Follow-ups retain earlier context; new selections add context using that choice. Start a new discussion to change it.</p>
      <p>In the library, imports are checked locally. Your next Send includes new evidence within that context choice. Last windows move to the latest archived message, and earlier shared evidence stays included. Only selected messages stays limited to your explicit selections. Importing or opening a discussion sends nothing.</p>
      <p>Selected static images and images retained from earlier turns are included. Audio, video, animated images and remote media are excluded.</p>
      <p>Discussions in your Echo library are saved automatically in its local database.</p>
    </div>
    <div v-if="developerBuild" class="chatgpt-settings__field">
      <NyxCheckbox v-model="viewerStore.developerMode" label="Developer mode" :size="NyxSize.Small" />
      <p>Adds Inspect context to the Echo toolbar. Inspection stays local and sends nothing.</p>
    </div>
  </section>
</template>

<style scoped lang="scss">
.chatgpt-settings {
  display: grid;
  gap: var(--nyx-gap-xl);
  &__field { display: grid; gap: var(--nyx-gap-sm); max-width: 70ch; label, h3 { font-size: 14px; font-weight: 600; } p { font-size: 13px; line-height: 1.6; color: var(--nyx-c-text-2); } .nyx-button { justify-self: start; } }
  :deep(.chatgpt-connection) { padding: 0; }
}
</style>
