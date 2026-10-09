<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NyxButton, NyxCheckbox, NyxIcon, NyxProgress, NyxSelect } from 'nyx-kit/components'
import { NyxSize, NyxTheme, NyxVariant } from 'nyx-kit/types'
import { createLibraryApi, LibraryApiError } from '../lib/library-api'
import type { ImportChoices, ImportJob } from '../../shared/library-types'
import PageHeading from './PageHeading.vue'
import ArchiveStatus from './ArchiveStatus.vue'
const props = withDefaults(defineProps<{ localServer?: boolean; loading?: boolean; archiveStatus?: string }>(), { localServer: true })
const emit = defineEmits<{ imported: []; close: []; chooseFolder: [] }>()
const api = createLibraryApi(), zipInput = ref<HTMLInputElement>(), folderInput = ref<HTMLInputElement>()
const job = ref<ImportJob>(), busy = ref(false), error = ref(''), transfer = ref(0)
const owner = ref(''), sameOwner = ref(false), conversationChoices = ref<Record<string, string>>({}), messageChoices = ref<Record<string, Record<string, string>>>({})
let alive = true, timer: ReturnType<typeof setTimeout> | undefined, uploadController: AbortController | undefined, lastCompleted = ''
const active = computed(() => !!job.value && !['completed', 'cancelled', 'failed', 'interrupted'].includes(job.value.state))
const status = computed(() => ({ transferring: 'Transferring to Echo on this device', extracting: 'Extracting export', validating: 'Checking history', review: 'Review uncertain matches', committing: 'Saving to your library', completed: 'Import complete', cancelled: 'Import cancelled', failed: 'Import could not finish', interrupted: 'Import was interrupted' })[job.value?.state ?? 'transferring'])
const progress = computed(() => job.value?.state === 'transferring' ? transfer.value : job.value?.progress ? Math.round(job.value.progress.completed / Math.max(1, job.value.progress.total) * 100) : null)
const progressDetail = computed(() => {
  const value = job.value?.progress
  if (!value || job.value?.state === 'transferring') return ''
  const counts = `${value.completed.toLocaleString()} of ${value.total.toLocaleString()}`
  const label = ({ extracting: 'Extracted files', validating: 'Checked JSON files', matching: 'Compared conversations', committing: 'Processed conversations' } as Record<string, string>)[value.phase]
  const current = value.current
  const detail = current ? ` · ${current.unit === 'messages' ? 'Processing messages' : 'Checking possible matches'}: ${current.completed.toLocaleString()} of ${current.total.toLocaleString()}` : ''
  return label ? `${label}: ${counts}${detail}` : ''
})
const explanations: Record<string, string> = {
  import_path: 'An input path is unsafe or unsupported. Choose an unmodified JSON export.', import_collision: 'The export contains conflicting file paths. Echo did not overwrite any history.',
  import_limit: 'This export exceeds an import limit. Request a smaller date range and import it separately.', import_disk_full: 'There is not enough free disk space. Free some space and try again.',
  import_zip_invalid: 'This ZIP is malformed, truncated, or split across volumes. Download a complete, independently readable export ZIP.',
  import_zip_encrypted: 'Password-protected ZIP files are not supported. Choose an unencrypted export.', import_zip_method: 'This ZIP uses an unsupported compression method. Use a stored or deflated ZIP.',
  import_zip_special: 'This ZIP contains links or special files. Choose an unmodified export.', import_integrity: 'An input integrity check failed. Download the export again.',
  import_html_only: 'Echo needs the JSON export format. Request a JSON export from Instagram.', import_no_messages: 'No supported JSON conversations were found in this selection.',
  import_owner_mismatch: 'This export belongs to a different account. One export owner is supported per library.', import_interrupted: 'The interrupted import was not resumed. Select its source again to retry.',
  import_cancelled: 'Committed history is unchanged.', import_busy: 'Another import or cleanup needs to finish first.',
  import_timeout: 'Checking this export exceeded the time limit. Your committed history is unchanged. Try a smaller date range.',
}
function labelSelect(control: unknown, label: string) {
  // nyx-kit's native select is hidden; name its visible keyboard control too.
  const root = (control as { $el?: HTMLElement } | null)?.$el
  root?.querySelector('[role="combobox"]')?.setAttribute('aria-label', label)
  root?.querySelector('select')?.setAttribute('aria-hidden', 'true')
}
function explain(failure: unknown) { return failure instanceof LibraryApiError && failure.code === 'session_required' ? 'Open Echo from its launcher to connect this browser.' : failure instanceof LibraryApiError && explanations[failure.code] || 'Echo could not finish this action. Check the connection and retry.' }
function update(value: ImportJob) {
  if (!alive) return
  const enteringReview = value.state === 'review' && (job.value?.state !== 'review' || !job.value?.review)
  job.value = value
  if (enteringReview && value.review) {
    owner.value = value.review.owner.label; sameOwner.value = false
    conversationChoices.value = {}; messageChoices.value = {}
    for (const group of value.review.conversations) messageChoices.value[group.key] = {}
  }
  if (value.state === 'completed' && lastCompleted !== value.id) { lastCompleted = value.id; emit('imported') }
}
async function poll() {
  if (!alive) return
  try {
    if (job.value) update(await api.importStatus(job.value.id))
    else { const result = await api.imports(); if (result.jobs[0]) update(result.jobs[0]) }
  } catch (failure) { if (alive) error.value = explain(failure) }
  finally { if (alive && active.value && job.value?.state !== 'transferring') timer = setTimeout(poll, 750) }
}
async function upload(event: Event, kind: 'folder' | 'zip') {
  const input = event.target as HTMLInputElement, files = Array.from(input.files ?? []); input.value = ''
  if (!files.length || busy.value) return
  busy.value = true; error.value = ''; transfer.value = 0
  uploadController = new AbortController()
  let createdId: string | undefined
  try {
    const created = await api.createImport(kind); createdId = created.id; update(created)
    const total = files.reduce((sum, file) => sum + file.size, 0); let sent = 0
    for (const file of files) {
      uploadController.signal.throwIfAborted()
      const entry = await api.beginImportFile(created.id, file.webkitRelativePath || file.name, file.size)
      for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
        uploadController.signal.throwIfAborted()
        const bytes = file.slice(offset, offset + 1024 * 1024)
        await api.uploadImportChunk(created.id, entry.id, offset, bytes, uploadController.signal)
        sent += bytes.size; transfer.value = total ? Math.round(sent / total * 100) : 100
      }
      await api.finishImportFile(created.id, entry.id)
    }
    uploadController.signal.throwIfAborted()
    update(await api.acceptImport(created.id)); void poll()
  } catch (failure) {
    if (alive && !uploadController.signal.aborted) error.value = explain(failure)
    // Incomplete transfer is never accepted as a complete job. Keep explicit
    // cancellation/retry available if connectivity prevents this cleanup.
    if (createdId) { try { update(await api.cancelImport(createdId)) } catch { /* The server recovers staging after restart. */ } }
  } finally { busy.value = false }
}
async function cancel() {
  if (!job.value) return
  uploadController?.abort(); busy.value = true
  try { update(await api.cancelImport(job.value.id)) } catch (failure) { error.value = explain(failure) }
  finally { busy.value = false }
}
async function review() {
  if (!job.value?.review) return
  const choices: ImportChoices = { conversations: conversationChoices.value, messages: messageChoices.value }
  if (job.value.review.owner.needsReview) choices.ownerChoice = { label: owner.value, sameOwner: sameOwner.value }
  busy.value = true; error.value = ''
  try { update(await api.reviewImport(job.value.id, choices)); void poll() } catch (failure) { error.value = explain(failure) }
  finally { busy.value = false }
}
async function cleanup() {
  if (!job.value) return
  busy.value = true
  try { update(await api.cleanupImport(job.value.id)) } catch (failure) { error.value = explain(failure) }
  finally { busy.value = false }
}
onMounted(() => { if (props.localServer) void poll() })
onUnmounted(() => { alive = false; clearTimeout(timer); uploadController?.abort() })
</script>

<template>
  <section class="library-import app-page" aria-labelledby="library-import-title">
    <PageHeading id="library-import-title" title="Import export" @back="emit('close')" />
    <p class="library-import__intro">{{ localServer ? 'Add an Instagram JSON export to your library. Echo checks for existing history before adding new messages.' : 'Open an extracted Instagram JSON export folder. Echo saves a copy in this browser for next time.' }}</p>
    <template v-if="localServer">
    <input ref="zipInput" type="file" accept=".zip,application/zip" class="library-import__input" aria-label="Choose Instagram export ZIP" tabindex="-1" @change="upload($event, 'zip')" />
    <input ref="folderInput" type="file" webkitdirectory multiple class="library-import__input" aria-label="Choose extracted export folder" tabindex="-1" @change="upload($event, 'folder')" />
    <div class="library-import__actions"><NyxButton :variant="NyxVariant.Soft" :disabled="busy || active || job?.cleanupRequired" @click="zipInput?.click()"><NyxIcon name="file-archive" :size="18" aria-hidden="true" />Choose ZIP</NyxButton><NyxButton :variant="NyxVariant.Subtle" :disabled="busy || active || job?.cleanupRequired" @click="folderInput?.click()"><NyxIcon name="folder-open" :size="18" aria-hidden="true" />Choose extracted folder</NyxButton></div>
    <p class="library-import__hint">Your source files stay untouched. Imported history and media stay on this device.</p>
    <p v-if="error" role="alert">{{ error }} <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" @click="poll">Retry connection</NyxButton></p>
    <div v-if="job" class="library-import__job">
      <h3 class="library-import__status" role="status"><NyxIcon v-if="job.state === 'completed'" name="circle-check" :size="21" aria-hidden="true" />{{ status }}</h3>
      <template v-if="active && job.state !== 'review'">
        <NyxProgress :model-value="progress" :theme="NyxTheme.Primary" :aria-label="status" />
        <p v-if="progressDetail" class="library-import__progress-detail" role="status">{{ progressDetail }}</p>
        <p>{{ job.state === 'transferring' ? 'Stay on this page until transfer finishes. Leaving cancels an incomplete transfer.' : 'You can browse your conversations or close this tab. Echo will keep working.' }}</p>
      </template>
      <p v-if="job.error">{{ explanations[job.error] || 'The import could not finish. Your previously committed history is available.' }}</p>
      <template v-if="job.summary">
        <dl class="library-import__summary">
          <div><dt>Added</dt><dd>{{ job.summary.additions.toLocaleString() }}</dd></div>
          <div><dt>Matched</dt><dd>{{ job.summary.matched.toLocaleString() }}</dd></div>
          <div><dt>Changed</dt><dd>{{ job.summary.changed.toLocaleString() }}</dd></div>
          <div><dt>Unavailable attachments</dt><dd>{{ job.summary.unavailableAssets.toLocaleString() }}</dd></div>
        </dl>
        <p v-if="!job.summary.additions && !job.summary.changed && !job.summary.conversations">No changes to your history.</p>
      </template>
      <form v-if="job.state === 'review' && job.review" class="library-import__review" @submit.prevent="review">
        <div v-if="job.review.owner.needsReview" class="library-import__field">
          <label for="import-owner">Who is “me” in this export?</label>
          <NyxSelect id="import-owner" :ref="control => labelSelect(control, 'Who is me in this export?')" v-model="owner" :options="job.review.owner.candidates.map(name => ({ label: name, value: name }))" />
          <NyxCheckbox v-if="job.review.owner.existing" v-model="sameOwner" tabindex="0" role="checkbox" :aria-checked="sameOwner" @keydown.space.prevent="sameOwner = !sameOwner" :label="`This is the same account as ${job.review.owner.existing.label}, the owner of this library.`" />
        </div>
        <template v-for="group in job.review.conversations" :key="group.key">
          <div v-if="!group.target" class="library-import__field">
            <label :for="`import-${group.key}`">{{ group.title }}: how should this history be kept?</label>
            <NyxSelect :id="`import-${group.key}`" :ref="control => labelSelect(control, `${group.title}: how should this history be kept?`)" v-model="conversationChoices[group.key]" :options="[{ label: 'Keep as a separate conversation', value: 'separate' }, ...group.candidates.map(item => ({ label: `Match ${item.title}`, value: item.id }))]" />
          </div>
          <div v-for="message in group.messages" :key="message.index" class="library-import__field">
            <label :for="`import-${group.key}-${message.index}`">{{ message.sender }}: {{ message.text || 'Attachment or activity' }}</label>
            <ul class="library-import__candidates"><li v-for="(candidate, index) in message.evidence" :key="candidate.id">Occurrence {{ index + 1 }}: {{ candidate.sender }}, {{ candidate.timestamp === null ? 'time unavailable' : new Date(candidate.timestamp).toLocaleString() }}<br />{{ candidate.text || 'Attachment or activity' }}<br /><small>Before: {{ candidate.before || 'No earlier context' }} · After: {{ candidate.after || 'No later context' }}</small></li></ul>
            <NyxSelect :id="`import-${group.key}-${message.index}`" :ref="control => labelSelect(control, `Resolve occurrence ${message.index + 1} from ${message.sender}`)" v-model="messageChoices[group.key]![String(message.index)]" :options="[{ label: 'Keep as a separate occurrence', value: 'separate' }, ...message.candidates.map((id, index) => ({ label: `Match existing occurrence ${index + 1}`, value: id }))]" />
          </div>
        </template>
        <p>Only confirmed matches are combined. Source observations are retained.</p>
        <NyxButton type="submit" :variant="NyxVariant.Soft" :loading="busy" :disabled="job.review.owner.needsReview && (!owner || (!!job.review.owner.existing && !sameOwner))">Apply review</NyxButton>
      </form>
      <NyxButton v-if="job.state === 'completed'" class="library-import__done" :variant="NyxVariant.Soft" @click="emit('close')">Browse conversations<NyxIcon name="arrow-right" :size="17" aria-hidden="true" /></NyxButton>
      <NyxButton v-if="active" :variant="NyxVariant.Subtle" :size="NyxSize.Small" @click="cancel">Cancel import</NyxButton>
      <p v-if="job.cleanupRequired" role="alert">Some temporary files could not be removed. <NyxButton :variant="NyxVariant.Subtle" :loading="busy" @click="cleanup">Retry cleanup</NyxButton></p>
    </div>
    </template>
    <template v-else>
      <div class="library-import__actions"><NyxButton :variant="NyxVariant.Soft" :disabled="loading" @click="emit('chooseFolder')"><NyxIcon name="folder-open" :size="18" aria-hidden="true" />Open folder</NyxButton></div>
      <p class="library-import__hint">Choose the extracted folder, not its ZIP file. Your original files stay untouched and nothing is uploaded.</p>
      <div v-if="archiveStatus" class="library-import__storage"><ArchiveStatus :text="archiveStatus" /></div>
      <NyxButton :variant="NyxVariant.Subtle" @click="emit('close')">Browse conversations</NyxButton>
    </template>
    <a class="library-import__export" href="https://accountscenter.facebook.com/info_and_permissions/dyi" target="_blank" rel="noopener noreferrer">Request a new JSON export<NyxIcon name="arrow-up-right" :size="15" aria-hidden="true" /></a>
  </section>
</template>
<style scoped lang="scss">
.library-import {
  h3 { margin: 0; font-size: var(--nyx-font-size-lg); font-weight: 650; }
  p { margin: 0; max-width: 70ch; line-height: 1.6; color: var(--nyx-c-text-2); font-size: var(--nyx-font-size-md); }
  &__intro { margin-bottom: var(--nyx-gap-xl); }
  &__hint { font-size: var(--nyx-font-size-sm) !important; }
  &__input { display: none; }
  &__storage { margin-block: var(--nyx-gap-xl); }
  &__actions { display: flex; flex-wrap: wrap; gap: var(--nyx-gap-md); margin-block: calc(var(--nyx-gap-xl) * 1.5) var(--nyx-gap-lg); }
  &__job { display: grid; justify-items: start; gap: var(--nyx-gap-xl); border-top: 1px solid var(--nyx-c-divider-light); margin-top: calc(var(--nyx-gap-xl) * 2); padding-top: calc(var(--nyx-gap-xl) * 2); > .nyx-progress { width: 100%; } }
  &__status { display: flex; align-items: center; gap: var(--nyx-gap-md); }
  &__summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--nyx-gap-lg) calc(var(--nyx-gap-xl) * 2); margin: 0; width: 100%; div { display: flex; justify-content: space-between; gap: var(--nyx-gap-md); } dt { color: var(--nyx-c-text-2); font-size: var(--nyx-font-size-sm); } dd { margin: 0; font-size: var(--nyx-font-size-md); font-variant-numeric: tabular-nums; } }
  &__review { display: grid; gap: calc(var(--nyx-gap-xl) * 1.5); width: 100%; > .nyx-button { justify-self: start; } }
  &__field { display: grid; gap: var(--nyx-gap-lg); min-width: 0; padding-bottom: var(--nyx-gap-xl); border-bottom: 1px solid var(--nyx-c-divider-light); .nyx-select { width: 100%; } }
  &__candidates { margin: 0; padding-left: 20px; font-size: .8rem; line-height: 1.5; li + li { margin-top: 12px; } }
  label { font-size: .875rem; overflow-wrap: anywhere; }
  &__export { display: inline-flex; align-items: center; gap: var(--nyx-gap-sm); margin-top: calc(var(--nyx-gap-xl) * 2); color: var(--nyx-c-text-2); font-size: var(--nyx-font-size-sm); text-underline-offset: 3px; }
  [role='alert'] { margin-top: var(--nyx-gap-xl); }
  @media (max-width: 600px) { &__summary { grid-template-columns: 1fr; } }
}
</style>
