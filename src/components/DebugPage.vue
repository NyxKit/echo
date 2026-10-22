<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { NyxActionItem, NyxButton, NyxProgress } from 'nyx-kit/components'
import { NyxSize, NyxTheme, NyxVariant } from 'nyx-kit/types'
import PageHeading from './PageHeading.vue'
import { useChatGPTConnection } from '../composables/useChatGPTConnection'
import { refreshLibraryDiscussionSubjects } from '../stores/library-analysis'
import { createLibraryApi, LibraryApiError } from '../lib/library-api'
import { backfillDiscussionSubjects, type SubjectBackfillProgress } from '../lib/discussion-subject-backfill'

defineProps<{ localServer: boolean }>()
defineEmits<{ back: [] }>()
const { connected, model } = useChatGPTConnection()
const api = createLibraryApi()
const running = ref(false)
const result = ref<SubjectBackfillProgress>()
const notice = ref('')
const error = ref('')
let controller: AbortController | undefined
async function run() {
  if (running.value || !connected.value || !model.value) return
  const current = new AbortController()
  controller = current
  running.value = true; result.value = undefined; notice.value = ''; error.value = ''
  try {
    const finished = await backfillDiscussionSubjects(api, model.value, current.signal, value => { result.value = value })
    notice.value = finished.total === 0 ? 'No discussions need a subject.' : 'Finished. Subjects are saved in your library.'
  } catch (cause) {
    if (current.signal.aborted) notice.value = 'Stopped. Subjects already saved are kept. Run again to continue.'
    else {
      const code = cause instanceof LibraryApiError ? cause.code : ''
      error.value = code === 'library_subject_connection_required' ? 'Connect ChatGPT in Settings, then retry.'
        : code === 'session_required' ? 'Open Echo from its launcher to connect this browser, then retry.'
        : code === 'library_subject_quota' ? 'ChatGPT usage is temporarily limited. Retry later.'
        : code === 'library_busy' ? 'Echo is busy. Wait for the current operation to finish, then retry.'
        : 'The update stopped. Check ChatGPT in Settings and retry. Subjects already saved are kept.'
    }
  } finally { await refreshLibraryDiscussionSubjects(); running.value = false; if (controller === current) controller = undefined }
}
onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <section class="debug-page" aria-labelledby="debug-title">
    <div class="debug-page__content app-page">
      <PageHeading id="debug-title" title="Debug" @back="$emit('back')" />
      <NyxActionItem title="Subjects for existing discussions" :theme="NyxTheme.Info">
        <p>Generate subjects for saved Echo discussions that still use their first prompt as a title. Custom titles are kept.</p>
        <p>Keep this page open while the update runs; leaving stops it.</p>
        <template #action>
          <div class="debug-page__actions">
            <NyxButton :variant="NyxVariant.Soft" :size="NyxSize.Small" :disabled="!localServer || !connected || !model || running" @click="run">Generate missing subjects</NyxButton>
            <NyxButton v-if="running" :variant="NyxVariant.Subtle" :size="NyxSize.Small" @click="controller?.abort()">Stop</NyxButton>
          </div>
        </template>
      </NyxActionItem>
      <div class="debug-page__status" role="status" aria-live="polite" aria-atomic="true">
        <p v-if="!localServer">This action requires Echo’s local library. Open Echo from its launcher.</p>
        <p v-else-if="!connected || !model">Connect ChatGPT and choose a default model in Settings to continue.</p>
        <p v-if="running && !result">Finding discussions…</p>
        <template v-if="result">
          <p>{{ result.processed }} of {{ result.total }} processed. {{ result.updated }} updated<span v-if="result.skipped">, {{ result.skipped }} skipped because they changed</span>.</p>
          <NyxProgress v-if="running && result.total" :model-value="result.processed / result.total * 100" :theme="NyxTheme.Primary" aria-label="Subject update progress" />
        </template>
        <p v-if="notice">{{ notice }}</p>
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
    </div>
  </section>
</template>

<style scoped lang="scss">
.debug-page {
  width: 100%; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  &__content { overflow: visible; }
  &__actions { display: flex; flex-wrap: wrap; gap: var(--nyx-gap-sm); }
  &__status { margin-top: var(--nyx-gap-xl); }
  p { max-width: 70ch; }
}
</style>
