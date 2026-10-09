<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { NyxButton, NyxDropdown, NyxIcon, NyxInput, NyxModal, NyxSelect, NyxSpinner, NyxTextarea } from 'nyx-kit/components'
import { useRouter } from 'vue-router'
import { useChatGPTConnection } from '../composables/useChatGPTConnection'
import { analysisPreferences } from '../stores/analysis-preferences'
import { contextChoices, contextLabel } from '../../shared/context-windows.mjs'
import { NyxPosition, NyxSize, NyxVariant } from 'nyx-kit/types'
import type { AssetIndex, Conversation } from '../lib/archive'
import { addThread, conversationAnalysis, deleteThread, sendAnalysis, stopAnalysis, type AnalysisTurn } from '../stores/analysis'
import ChatGPTConnection from './ChatGPTConnection.vue'
import AnalysisAnswer from './AnalysisAnswer.vue'
import { messageReference, prepareAnalysis, sourceVersion, contextVersion } from '../lib/analysis-context'
import { ASK_ECHO_LABEL } from '../config'
import { viewerStore } from '../stores/viewer'
import { prepareLibraryAnalysis, retryLibrarySave, reloadLibraryDiscussions } from '../stores/library-analysis'
import { validateAnalysis, type AnalysisContext, type ContextScope, type AnalysisPayload } from '../../shared/analysis-policy.mjs'

const props = defineProps<{ conversation: Conversation; assets: AssetIndex }>()
const emit = defineEmits<{ jump: [index: number] }>()
const state = computed(() => conversationAnalysis(props.conversation.id))
const thread = computed(() => state.value.threads.find(item => item.id === state.value.activeThread)!)
const busy = computed(() => thread.value.turns.some(turn => turn.status === 'sending'))
const selected = computed(() => {
  const ids = new Set(state.value.selection.ids)
  return props.conversation.messages.flatMap((message, index) => ids.has(message.id) ? [{ message, index }] : [])
})
const hasHistory = computed(() => thread.value.turns.some(turn => turn.status === 'complete'))
const canSend = computed(() => state.value.storageStatus !== 'loading' && (!!selected.value.length || (!!draft.value.trim() && (hasHistory.value || !!props.conversation.messages.length))))
const router = useRouter()
const { connected, model, modelError, modelsLoading } = useChatGPTConnection()
const error = ref('')
const preparing = ref(false)
const prepared = shallowRef<AnalysisPayload>()
let preparedSelection: string[] = []
const developerBuild = import.meta.env.DEV
const developerMode = computed(() => developerBuild && viewerStore.developerMode)
const ContextInspector = import.meta.env.DEV ? defineAsyncComponent(() => import('./AnalysisContextInspector.vue')) : undefined
const inspected = shallowRef<AnalysisPayload>()
const lastRequest = shallowRef<AnalysisPayload>()
const inspectorSubmitted = ref(false)
const rename = ref(false)
const settingsOpen = ref(false)
const settingsModal = ref<{ $el: HTMLDialogElement }>()
const discussionSelect = ref<{ $el: HTMLElement }>()
const scopeLabel = (scope: AnalysisContext['scope'], attached = false) => contextLabel(scope, attached)
const scope = computed({
  get: (): ContextScope => {
    const initial = thread.value.turns.find(turn => turn.status === 'complete')?.context.scope
    if (initial && initial !== 'discussion') return initial
    if (thread.value.scope === 'surrounding') return 'week'
    return !selected.value.length && thread.value.scope === 'selected' ? (analysisPreferences.defaultContext === 'selected' ? 'week' : analysisPreferences.defaultContext) : thread.value.scope
  },
  set: (value: ContextScope) => { if (!hasHistory.value) thread.value.scope = value },
})
const contextOptions = computed(() => contextChoices.filter(value => value !== 'selected' || selected.value.length).map(value => ({ value, label: contextLabel(value, !!selected.value.length), icon: value === scope.value ? 'check' : undefined, disabled: busy.value || preparing.value })))
function changeScope(option: { value: string }) { if (!hasHistory.value && contextOptions.value.some(item => item.value === option.value && !item.disabled)) scope.value = option.value as ContextScope }
function labelSelect(control: { $el: HTMLElement } | undefined, label: string) {
  // The kit's id labels its hidden native select, not its visible combobox.
  control?.$el.querySelector('[role="combobox"]')?.setAttribute('aria-label', label)
  control?.$el.querySelector('select')?.setAttribute('aria-hidden', 'true')
}
watch(discussionSelect, value => labelSelect(value, 'Current discussion'), { flush: 'post' })
const transcript = ref<HTMLElement>()
const composer = ref<HTMLElement>()
const followResponse = ref(true)
const discussionActions = computed(() => [
  { label: 'Rename discussion', value: 'rename', icon: 'pencil' },
  ...(!busy.value ? [{ label: 'Delete discussion', value: 'delete', icon: 'trash-2' }] : []),
])
async function discussionAction(option: { value: string }) {
  if (option.value === 'delete') deleteThread(state.value, thread.value.id)
  else {
    rename.value = !rename.value
    await nextTick()
    document.getElementById('discussion-name')?.focus()
  }
}
function onTranscriptScroll() {
  const el = transcript.value
  if (el) followResponse.value = el.scrollHeight - el.scrollTop - el.clientHeight < 64
}
async function scrollToResponse() {
  await nextTick()
  if (followResponse.value && transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight
}
watch(() => thread.value.turns.map(turn => `${turn.answer.length}:${turn.status}`).join(','), scrollToResponse)
watch(() => state.value.activeThread, () => { rename.value = false; followResponse.value = true; void scrollToResponse() })
async function fitComposer() {
  await nextTick()
  const textarea = composer.value?.querySelector('textarea')
  if (textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(200, textarea.scrollHeight)}px` }
}
function modalKey(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.stopPropagation()
  if (event.defaultPrevented) return
  // Consume native cancel so the underlying mobile shelf stays open.
  event.preventDefault()
  settingsOpen.value = false
}
function modalEscapeFallback(event: KeyboardEvent) {
  const modal = settingsOpen.value ? settingsModal.value : undefined
  // A disappearing connection action can leave focus on the document body.
  if (modal && !modal.$el.contains(event.target as Node)) modalKey(event)
}
function composerKey(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (!busy.value && !preparing.value) void requestSend()
}
async function requestSend() {
  if (!connected.value) { settingsOpen.value = true; return }
  if (!model.value) { error.value = modelsLoading.value ? 'Models are still loading. Try again in a moment.' : modelError.value || 'Choose an available default model in Settings.'; return }
  if (!canSend.value || busy.value || preparing.value) return
  composer.value?.querySelector('textarea')?.focus({ preventScroll: true })
  await prepare()
  if (prepared.value) await send()
}

const draft = computed({ get: () => thread.value.draft, set: (value: string) => { thread.value.draft = value } })
const threadOptions = computed(() => state.value.threads.map(item => ({ label: item.title, value: item.id })))
watch([() => state.value.selection.ids.join(','), draft, model, scope, () => state.value.activeThread, connected], () => {
  prepared.value = undefined
  if (!inspectorSubmitted.value) inspected.value = undefined
})
watch([() => state.value.activeThread, () => props.conversation.id, developerMode], () => { inspected.value = undefined; lastRequest.value = undefined })
watch(draft, fitComposer)
async function prepare() {
  error.value = ''; preparing.value = true; prepared.value = undefined
  const current = thread.value
  const selection = [...state.value.selection.ids]
  const question = draft.value.trim() || 'Help me understand the selected messages, using the shared context. Distinguish what is clear from possible interpretations.'
  if (!draft.value.trim()) draft.value = question
  const selectedModel = model.value
  const selectedScope = scope.value
  try {
    const history = current.turns.filter(turn => turn.status === 'complete').map(turn => ({ question: turn.question, focus: [...turn.focus], context: JSON.parse(JSON.stringify(turn.context)), images: [...turn.images], excluded: [...turn.excluded], answer: turn.answer }))
    const result = props.conversation.libraryRevision !== undefined
      ? await prepareLibraryAnalysis(current, { question, focus: selection, scope: selectedScope, model: selectedModel })
      : !selection.length && history.length && current.contextSource
      ? validateAnalysis({ requestId: crypto.randomUUID(), model: selectedModel, sourceVersion: current.contextSource.sourceVersion,
        sourceParts: current.contextSource.sourceParts, contextVersion: await contextVersion(current.contextSource.sourceParts), history,
        turn: { question, focus: [], context: { scope: 'discussion' }, images: [], excluded: [] } })
      : await prepareAnalysis(props.conversation, props.assets, selection, question, history, selectedModel, selectedScope)
    if (thread.value !== current || !connected.value || draft.value.trim() !== question || model.value !== selectedModel || scope.value !== selectedScope || state.value.selection.ids.join(',') !== selection.join(',')) return
    if (current.sourceVersion && current.sourceVersion !== result.sourceVersion) throw new Error('The source changed. Start a new discussion before sending.')
    preparedSelection = selection
    prepared.value = result
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'The context could not be prepared.' }
  finally { preparing.value = false }
}
async function send() {
  const payload = prepared.value
  if (!payload || preparing.value || busy.value || !connected.value) return
  const current = thread.value
  const currentState = state.value
  const sentIds = new Set(props.conversation.libraryRevision !== undefined ? preparedSelection : props.conversation.messages.filter(message => payload.turn.focus.includes(messageReference(message) ?? '')).map(message => message.id))
  preparing.value = true
  try {
    if (props.conversation.libraryRevision === undefined && !(payload.turn.context.scope === 'discussion' && current.contextSource) && await sourceVersion(props.conversation) !== payload.sourceVersion) throw new Error('The source changed. Review your context again.')
    if (prepared.value !== payload || thread.value !== current || !connected.value) return
    prepared.value = undefined
    if (developerMode.value) {
      lastRequest.value = payload
      if (inspected.value) { inspected.value = payload; inspectorSubmitted.value = true }
    }
    followResponse.value = true
    await sendAnalysis(current, payload, () => {
      currentState.selection.ids = currentState.selection.ids.filter(id => !sentIds.has(id))
      if (currentState.selection.anchor && sentIds.has(currentState.selection.anchor)) currentState.selection.anchor = undefined
    })
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'The analysis could not start.' }
  finally { preparing.value = false }
}
async function inspectContext() {
  settingsOpen.value = false
  if (!developerMode.value || busy.value || preparing.value) return
  if (!canSend.value && lastRequest.value) { inspected.value = lastRequest.value; inspectorSubmitted.value = true; return }
  if (!canSend.value) return
  if (!connected.value) { settingsOpen.value = true; return }
  if (!model.value) { error.value = modelsLoading.value ? 'Models are still loading. Try again in a moment.' : modelError.value || 'Choose an available default model in Settings.'; return }
  await prepare()
  if (prepared.value && developerMode.value) { inspected.value = prepared.value; inspectorSubmitted.value = false }
}
function retry(turn: AnalysisTurn) {
  state.value.selection.ids = turn.referenceMap ? turn.focus.map(reference => turn.referenceMap![reference]).filter((id): id is string => Boolean(id)) : props.conversation.messages.filter(message => turn.focus.includes(messageReference(message) ?? '')).map(message => message.id)
  draft.value = turn.question
  void requestSend()
}
function remove(id: string) { state.value.selection.ids = state.value.selection.ids.filter(value => value !== id) }
onMounted(() => {
  window.addEventListener('keydown', modalEscapeFallback, true)
  settingsModal.value?.$el.querySelector('.nyx-modal__close')?.setAttribute('aria-label', 'Close ChatGPT connection')
  void fitComposer()
  void scrollToResponse()
})
onUnmounted(() => window.removeEventListener('keydown', modalEscapeFallback, true))
</script>

<template>
  <div class="conversation-analysis">
    <section class="conversation-analysis__navigation" aria-label="Discussions">
      <div class="conversation-analysis__toolbar">
        <label for="analysis-discussion" class="sr-only">Current discussion</label>
        <NyxSelect ref="discussionSelect" id="analysis-discussion" v-model="state.activeThread" :options="threadOptions" :size="NyxSize.Small" />
        <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" aria-label="New discussion" title="New discussion" @click="addThread(state)"><NyxIcon name="square-pen" :size="19" /></NyxButton>
        <NyxDropdown :options="discussionActions" :size="NyxSize.Small" @select="discussionAction" @keydown.esc.stop><NyxIcon name="ellipsis" :size="19" /><span class="sr-only">Discussion actions</span></NyxDropdown>
        <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" :aria-label="`${ASK_ECHO_LABEL} settings`" :title="`${ASK_ECHO_LABEL} settings`" @click="router.push({ name: 'settings' })"><NyxIcon name="settings" :size="19" /></NyxButton>
        <NyxButton v-if="developerMode" :variant="NyxVariant.Subtle" :size="NyxSize.Small" :disabled="(!canSend && !lastRequest) || busy || preparing" aria-label="Inspect context" title="Inspect context" @click="inspectContext"><NyxIcon name="code" :size="19" /></NyxButton>
      </div>
      <div v-if="rename" class="conversation-analysis__rename"><label for="discussion-name">Discussion name</label><NyxInput id="discussion-name" v-model="thread.title" :maxlength="160" :size="NyxSize.Small" @keydown.enter.prevent="rename = false" /><NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" @click="rename = false">Done</NyxButton></div>
    </section>
    <section class="conversation-analysis__chat" :aria-label="`${ASK_ECHO_LABEL} discussion`">
      <div ref="transcript" class="conversation-analysis__transcript" @scroll.passive="onTranscriptScroll">
        <div v-if="!thread.turns.length" class="conversation-analysis__empty">
          <h3>What would you like to understand?</h3>
          <p>Ask about this conversation, or click messages to focus on a passage. Shift-click to select several.</p>
          <NyxButton v-if="!connected" :variant="NyxVariant.Subtle" :size="NyxSize.Small" @click="settingsOpen = true">Connect ChatGPT</NyxButton>
        </div>
        <ol v-else class="conversation-analysis__turns" aria-label="Questions and answers">
          <li v-for="turn in thread.turns" :key="turn.id">
            <div class="conversation-analysis__question"><span class="sr-only">You: </span><p>{{ turn.question }}</p><span><template v-if="turn.focus.length">{{ turn.focus.length }} {{ turn.focus.length === 1 ? 'message' : 'messages' }} · </template>{{ turn.context.scope === 'surrounding' && !turn.focus.length ? `Latest ${turn.context.references.length} ${turn.context.references.length === 1 ? 'message' : 'messages'}` : scopeLabel(turn.context.scope, !!turn.focus.length) }}<template v-if="turn.images.length"> · {{ turn.images.length }} {{ turn.images.length === 1 ? 'image' : 'images' }}</template></span></div>
            <ul v-if="turn.excluded.length" class="conversation-analysis__note"><li v-for="(item, index) in turn.excluded" :key="index">{{ item.reason }}</li></ul>
            <div class="conversation-analysis__answer">
              <span class="sr-only">ChatGPT: </span>
              <AnalysisAnswer v-if="turn.answer" :text="turn.answer" :conversation="conversation" :reference-map="turn.referenceMap" @jump="emit('jump', $event)" />
              <p v-if="turn.status === 'sending'" class="conversation-analysis__note" role="status">{{ turn.answer ? 'Responding…' : 'Thinking…' }}</p>
              <p v-if="turn.error" class="conversation-analysis__note" role="status">{{ turn.error }}</p>
              <NyxButton v-if="turn.status === 'failed' || turn.status === 'canceled' || turn.status === 'interrupted'" :variant="NyxVariant.Subtle" :size="NyxSize.Small" :disabled="busy || !connected" @click="retry(turn)">Retry</NyxButton>
            </div>
          </li>
        </ol>
      </div>
      <ContextInspector v-if="developerMode && inspected" :payload="inspected" :submitted="inspectorSubmitted" @close="inspected = undefined" />
      <div class="conversation-analysis__compose-area">
        <p v-if="state.storageStatus === 'loading' || state.storageStatus === 'error'" class="conversation-analysis__disclosure" role="status">{{ state.storageStatus === 'loading' ? 'Loading saved discussions…' : state.storageError }}
          <template v-if="state.storageStatus === 'error'"><NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" @click="retryLibrarySave(state)">Retry save</NyxButton><NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" title="Replaces local drafts with the saved discussions. Copy any unsaved text first." @click="reloadLibraryDiscussions(state)">Reload saved discussions</NyxButton></template>
        </p>
        <p v-if="error" class="conversation-analysis__error" role="alert">{{ error }}</p>
        <div v-if="!hasHistory" class="conversation-analysis__context">
          <NyxDropdown :options="contextOptions" :position="NyxPosition.Top" :size="NyxSize.Small" @select="changeScope" @keydown.esc.stop><span>Context: {{ scopeLabel(scope, !!selected.length) }}</span><NyxIcon name="chevron-down" :size="14" /></NyxDropdown>
        </div>
        <div ref="composer" class="conversation-analysis__composer">
          <ul v-if="selected.length" class="conversation-analysis__chips" aria-label="Selected messages">
            <li v-for="({ message, index }, selectionIndex) in selected" :key="message.id" class="conversation-analysis__chip">
              <NyxButton class="conversation-analysis__chip-preview" :variant="NyxVariant.Subtle" :size="NyxSize.Small" :aria-label="`View selected message ${selectionIndex + 1} from ${message.sender}`" :title="message.text || 'Attachment message'" @click="emit('jump', index)"><span>{{ message.sender }}</span><span>{{ message.text || 'Attachment message' }}</span></NyxButton>
              <NyxButton class="conversation-analysis__chip-remove" :variant="NyxVariant.Subtle" :size="NyxSize.Small" :aria-label="`Remove selected message ${selectionIndex + 1}`" @click="remove(message.id)"><NyxIcon name="x" :size="14" /></NyxButton>
            </li>
          </ul>
          <div class="conversation-analysis__input">
            <label for="analysis-question" class="sr-only">Ask about this conversation</label>
            <NyxTextarea id="analysis-question" v-model="draft" :maxlength="16000" :readonly="busy || preparing || state.storageStatus === 'loading'" :variant="NyxVariant.Subtle" :placeholder="hasHistory ? 'Ask a follow-up…' : 'Ask about this conversation…'" @keydown="composerKey" />
            <NyxButton v-if="busy" class="conversation-analysis__send" :variant="NyxVariant.Soft" :size="NyxSize.Small" aria-label="Stop response" title="Stop response" @click="stopAnalysis(thread.id)"><NyxIcon name="square" :size="18" /></NyxButton>
            <NyxButton v-else class="conversation-analysis__send" :variant="NyxVariant.Soft" :size="NyxSize.Small" :loading="preparing" :disabled="preparing || !canSend" aria-label="Send message" title="Send message (Enter)" @click="requestSend"><NyxIcon name="arrow-up" :size="20" /><template #loading><NyxSpinner :size="NyxSize.XSmall" /></template></NyxButton>
          </div>
        </div>

      </div>
    </section>
    <NyxModal ref="settingsModal" v-model="settingsOpen" title="Connect ChatGPT" custom-class="analysis-settings" @keydown="modalKey" @cancel.stop>
      <ChatGPTConnection />
    </NyxModal>
  </div>
</template>
