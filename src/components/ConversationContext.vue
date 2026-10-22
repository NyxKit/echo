<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NyxButton, NyxEditor } from 'nyx-kit/components'
import { NyxEditorFormat, NyxEditorMode, NyxSize, NyxVariant } from 'nyx-kit/types'
import { useRouter } from 'vue-router'
import { contextDraft, editContextDraft, flushContextDraft, loadContextDraft, resolveContextConflict, retryContextDraft } from '../stores/conversation-context'
import { conversationRoutes } from '../lib/conversation-routes'
import { editorMarkdown } from '../../shared/conversation-context.mjs'

const props = defineProps<{ conversationId: string }>()
const state = contextDraft(props.conversationId)
const router = useRouter(), surface = ref<HTMLElement>()
const model = ref(''), links = ref(new Map<string, string>())
const hintId = `context-hint-${props.conversationId}`
const editorKey = computed(() => `${props.conversationId}:${state.editorVersion}`)
watch(() => [state.loaded, state.editorVersion], () => { if (state.loaded) model.value = editorMarkdown(state.draft) }, { immediate: true })
watch(() => state.details?.inherited, async items => {
  links.value = await conversationRoutes((items ?? []).map(item => ({ id: item.conversationId })))
}, { immediate: true })
function changed(value: string) { model.value = value; editContextDraft(props.conversationId, value) }
function flush() { void flushContextDraft(props.conversationId).catch(() => {}) }
function retry() { void retryContextDraft(props.conversationId).catch(() => {}) }
function recover(keep: boolean) { void resolveContextConflict(props.conversationId, keep).catch(() => {}) }
function preventLink(event: MouseEvent) { if ((event.target as HTMLElement).closest('a')) { event.preventDefault(); event.stopPropagation() } }
function paste(event: ClipboardEvent) {
  // Let Tiptap insert plain text rather than parsing pasted active HTML.
  if (event.clipboardData?.types.includes('text/html')) {
    event.preventDefault(); event.stopPropagation()
    const selection = window.getSelection()
    if (!selection?.rangeCount || !surface.value?.contains(selection.anchorNode)) return
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'))
  }
}
function labelEditor() {
  const editor = surface.value?.querySelector<HTMLElement>('.tiptap')
  if (!editor) return
  editor.setAttribute('role', 'textbox'); editor.setAttribute('aria-label', 'Conversation context')
  editor.setAttribute('aria-multiline', 'true'); editor.setAttribute('aria-describedby', hintId)
  editor.dataset.placeholder = 'Add background about this person or conversation…'
}
let observer: MutationObserver | undefined
let formattingObserver: MutationObserver | undefined
onMounted(() => {
  observer = new MutationObserver(labelEditor)
  if (surface.value) observer.observe(surface.value, { childList: true, subtree: true })
  // NyxEditor teleports its formatting menu to body. A native modal shelf makes
  // body siblings inert, so keep that existing menu inside the active dialog.
  formattingObserver = new MutationObserver(() => {
    if (!surface.value?.contains(window.getSelection()?.anchorNode ?? null)) return
    const menu = document.querySelector<HTMLElement>('.nyx-editor__bubble')
    if (!menu) return
    menu.classList.add('conversation-context__formatting')
    const dialog = surface.value.closest('dialog[open]')
    if (dialog && menu.parentElement !== dialog) dialog.append(menu)
  })
  formattingObserver.observe(document.body, { childList: true, subtree: true })
  void loadContextDraft(props.conversationId).then(() => nextTick(labelEditor))
})
onBeforeUnmount(() => { observer?.disconnect(); formattingObserver?.disconnect(); flush() })
</script>

<template>
  <section class="conversation-context" aria-label="Conversation context editor">
    <p :id="hintId" class="conversation-context__hint">Background supplied by you. Included when you send a question to Echo.</p>
    <p v-if="!state.loaded && !state.error" role="status">Loading context…</p>
    <div ref="surface" class="conversation-context__surface" @keydown.stop @click.capture="preventLink" @auxclick.capture="preventLink" @paste.capture="paste" @drop.capture.prevent>
      <NyxEditor v-if="state.loaded" :key="editorKey" :model-value="model" :mode="NyxEditorMode.Zen" :format="NyxEditorFormat.Markdown" :size="NyxSize.Small" :has-source-toggle="false" :has-footer="false" placeholder="Add background about this person or conversation…" @update:model-value="changed" @blur="flush" />
    </div>
    <div v-if="state.error" class="conversation-context__error" role="alert">
      <p>{{ state.error }}</p>
      <template v-if="state.conflict">
        <p>Saved version:</p><pre tabindex="0">{{ state.conflict.markdown || 'Empty context' }}</pre>
        <NyxButton :variant="NyxVariant.Soft" :size="NyxSize.Small" @click="recover(true)">Keep my draft</NyxButton>
        <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" @click="recover(false)">Use saved version</NyxButton>
      </template>
      <NyxButton v-else :variant="NyxVariant.Soft" :size="NyxSize.Small" @click="retry">Retry context</NyxButton>
    </div>
    <div v-if="state.details?.inherited.length" class="conversation-context__inherited">
      <p>Individual context also included:</p>
      <ul><li v-for="item in state.details.inherited" :key="item.conversationId"><a v-if="links.has(item.conversationId)" :href="router.resolve({ name: 'conversation', params: { id: links.get(item.conversationId) } }).href">{{ item.participant }} · {{ item.title }}</a></li></ul>
    </div>
    <p v-if="state.details?.inheritance === 'unresolved'" class="conversation-context__hint">Individual context is unavailable because participant identities could not be verified. You can still use this group’s context.</p>
  </section>
</template>

<style scoped lang="scss">
.conversation-context {
  display: grid; gap: var(--nyx-gap-sm); min-width: 0; font-size: 13px;
  &__hint, &__inherited { color: var(--nyx-c-text-2); line-height: 1.6; }
  &__surface { min-width: 0; overflow-wrap: anywhere; }
  &__error { display: grid; gap: var(--nyx-gap-sm); .nyx-button { justify-self: start; } pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 200px; overflow: auto; } }
  &__inherited { ul { padding-inline-start: var(--nyx-gap-lg); } a { color: var(--nyx-c-text-1); text-decoration: underline; } }
  :deep(.nyx-editor) { min-width: 0; max-width: 100%; }
  :deep(.tiptap) { position: relative; min-height: 130px; overflow-wrap: anywhere; }
  :deep(.tiptap pre) { white-space: pre-wrap; }
  :deep(.tiptap:has(> p:only-child:empty))::before { content: attr(data-placeholder); color: var(--nyx-c-text-3); pointer-events: none; position: absolute; max-width: 24ch; }
}
:global(.conversation-context__formatting) { max-width: calc(100vw - 2 * var(--nyx-gap-sm)); flex-wrap: wrap; }
</style>
