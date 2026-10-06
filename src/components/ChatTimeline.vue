<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef, toRef, watch } from 'vue'
import { NyxButton, NyxIcon } from 'nyx-kit/components'
import { NyxSize, NyxTheme, NyxVariant } from 'nyx-kit/types'
import type { AssetIndex, Conversation } from '../lib/archive'
import { conversationPicture, dateLabel } from '../lib/archive'
import { useMessageHistory, type ReadingPosition } from '../composables/useMessageHistory'
import ArchiveStatus from './ArchiveStatus.vue'
import AttachmentView from './AttachmentView.vue'
import MessageText from './MessageText.vue'
import LinkPreview from './LinkPreview.vue'
import { messageLinks } from '../lib/link-preview'
import ProfileAvatar from './ProfileAvatar.vue'
import SideShelf from './SideShelf.vue'
import ConversationInfo from './ConversationInfo.vue'
import AssetLightbox from './AssetLightbox.vue'
import { conversationGallery, type GallerySelection } from '../lib/gallery'
import { displayMessage, emojiHearts } from '../lib/message-display'
import { ASK_ECHO_LABEL } from '../config'
import { viewerStore } from '../stores/viewer'
import ConversationAnalysis from './ConversationAnalysis.vue'
import { conversationAnalysis } from '../stores/analysis'
import { toggleMessageSelection } from '../lib/message-selection'

const props = defineProps<{ conversation: Conversation; assets: AssetIndex; selfName: string; selfConfidence: number; archiveStatus: string; position?: ReadingPosition }>()
const emit = defineEmits<{ back: []; position: [value: ReadingPosition, id: string]; self: [name: string] }>()
const timeline = ref<HTMLElement>()
const heading = ref<HTMLElement>()
const query = ref('')
const match = ref(0)
const shelfOpen = toRef(viewerStore, 'shelfOpen')
const analysisOpen = toRef(viewerStore, 'analysisOpen')
const focusAnalysisOnOpen = ref(true)
function toggleAnalysis() {
  focusAnalysisOnOpen.value = true
  analysisOpen.value = !analysisOpen.value
}
const extendedMessages = toRef(viewerStore, 'extendedMessages')
const analysis = computed(() => conversationAnalysis(props.conversation.id))
const analysisIds = computed(() => new Set(analysis.value.selection.ids))
const displayed = computed(() => props.conversation.messages.flatMap(message => {
  const visible = displayMessage(message, extendedMessages.value)
  return visible ? [visible] : []
}))
function selectMessage(id: string, range: boolean) {
  analysis.value.selection = toggleMessageSelection(analysis.value.selection, id, displayed.value.map(message => message.id), range)
  if (analysis.value.selection.ids.includes(id)) {
    focusAnalysisOnOpen.value = false
    analysisOpen.value = true
  }
}
const interactiveMessageContent = 'a, button, input, textarea, select, audio, video, [role="button"]'
function selectionClick(id: string, event: MouseEvent) {
  if ((event.target as HTMLElement).closest(interactiveMessageContent)) return
  if (!event.shiftKey && !window.getSelection()?.isCollapsed) return
  selectMessage(id, event.shiftKey)
}
function selectionPointer(event: MouseEvent) {
  if (event.shiftKey && !(event.target as HTMLElement).closest(interactiveMessageContent)) event.preventDefault()
}
const focusedMessage = ref('')
const lightbox = shallowRef<GallerySelection>()
const gallery = computed(() => conversationGallery(props.conversation, props.assets))
function openAsset(id: string) {
  const index = gallery.value.findIndex(item => item.id === id)
  if (index >= 0) lightbox.value = { items: gallery.value, index }
}
let searchOrigin: ReadingPosition | undefined
const { start, messages, loading, loadingAll, capture, restoreReadingPosition, reveal, loadAll, onScroll, onMediaLoad } = useMessageHistory(
  displayed, timeline, props.position,
  position => emit('position', searchOrigin ? { ...searchOrigin, start: position.start } : position, props.conversation.id),
)
const total = computed(() => displayed.value.length)
const matches = computed(() => {
  const needle = emojiHearts(query.value.trim()).toLocaleLowerCase()
  if (!needle) return []
  return displayed.value.flatMap((message, index) => message.text.toLocaleLowerCase().includes(needle) || message.sender.toLocaleLowerCase().includes(needle) ? [index] : [])
})
const selectedMessage = computed(() => displayed.value[matches.value[match.value]])
const participantSummary = computed(() => props.conversation.participants.join(', ') || 'Conversation archive')

async function showMatch(index: number) {
  if (!matches.value.length) return
  match.value = (index + matches.value.length) % matches.value.length
  focusedMessage.value = ''
  await reveal(matches.value[match.value])
}
async function viewMatch() {
  if (!matches.value.length) return
  shelfOpen.value = false
  await nextTick()
  await reveal(matches.value[match.value], true)
}
async function jumpToMessage(index: number) {
  shelfOpen.value = false
  if (window.matchMedia('(max-width: 999px)').matches) analysisOpen.value = false
  query.value = ''
  await nextTick()
  focusedMessage.value = props.conversation.messages[index].id
  if (!displayed.value.some(message => message.id === focusedMessage.value)) {
    extendedMessages.value = true
    await nextTick()
    focusedMessage.value = props.conversation.messages[index].id
  }
  const visibleIndex = displayed.value.findIndex(message => message.id === focusedMessage.value)
  if (visibleIndex >= 0) await reveal(visibleIndex, true)
}
watch(query, async (value, previous) => {
  if (value.trim() && !previous.trim()) searchOrigin = capture()
  match.value = 0
  if (value.trim()) await showMatch(0)
  else if (searchOrigin) {
    const origin = searchOrigin
    searchOrigin = undefined
    await restoreReadingPosition(origin)
  }
})
watch(extendedMessages, () => { match.value = 0; searchOrigin = undefined; focusedMessage.value = '' })
function dayStart(index: number) {
  const current = messages.value[index]
  const previous = messages.value[index - 1]
  return !previous || dateLabel(current.timestamp) !== dateLabel(previous.timestamp)
}
function grouped(index: number) {
  const current = messages.value[index]
  const previous = messages.value[index - 1]
  return !!previous && previous.sender === current.sender && !dayStart(index) && current.timestamp !== null && previous.timestamp !== null && current.timestamp - previous.timestamp < 300000
}
onMounted(() => heading.value?.focus({ preventScroll: true }))
</script>

<template>
  <div class="chat-layout" :class="{ 'chat-layout--analysis': analysisOpen }">
  <section class="chat" aria-labelledby="conversation-title">
    <header class="chat__header">
      <NyxButton class="chat__back" :variant="NyxVariant.Subtle" aria-label="Back to conversations" @click="emit('back')"><NyxIcon name="arrow-left" :size="20" /></NyxButton>
      <ProfileAvatar :name="conversation.title" :picture="conversationPicture(conversation, selfName)" :assets="assets" />
      <div class="chat__identity">
        <h2 id="conversation-title" ref="heading" tabindex="-1">{{ conversation.title }}</h2>
        <p :title="participantSummary">{{ participantSummary }}</p>
      </div>
      <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" :aria-expanded="analysisOpen" aria-controls="analysis-shelf" @click="toggleAnalysis"><NyxIcon name="sparkles" :size="18" aria-hidden="true" />{{ ASK_ECHO_LABEL }}</NyxButton>
      <NyxButton :variant="shelfOpen ? NyxVariant.Soft : NyxVariant.Subtle" :theme="NyxTheme.Primary" aria-label="Conversation information" :aria-expanded="shelfOpen" aria-controls="conversation-shelf" @click="shelfOpen = !shelfOpen"><NyxIcon name="panel-right" :size="20" /></NyxButton>
    </header>
    <div v-if="!selfName" class="chat__self-hint"><span>Which participant is you?</span><NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" @click="shelfOpen = true">Choose your name</NyxButton></div>
    <div ref="timeline" class="chat__timeline" tabindex="0" aria-label="Messages" @scroll.passive="onScroll" @load.capture="onMediaLoad" @loadedmetadata.capture="onMediaLoad">
      <div class="chat__messages">
        <p v-if="total" class="chat__history-status" role="status">{{ loading || loadingAll ? 'Loading earlier messages…' : start > 0 ? 'Scroll up for earlier messages' : 'Beginning of conversation' }}</p>
        <p v-if="!total" class="chat__empty">{{ conversation.messages.length ? 'No visible messages. Enable extended messages in conversation information.' : 'This conversation has no exported messages.' }}</p>
        <template v-for="(message, index) in messages" :key="message.id">
            <div v-if="dayStart(index)" class="chat__date">{{ dateLabel(message.timestamp) }}</div>
            <article class="message" :class="{ 'message--grouped': grouped(index), 'message--self': selfName === message.sender, 'message--match': (query.trim() && selectedMessage?.id === message.id) || focusedMessage === message.id, 'message--selected': analysisIds.has(message.id) }" :data-message-id="message.id" tabindex="0" :aria-label="`${analysisIds.has(message.id) ? 'Selected message' : 'Message'} from ${message.sender}. Enter to toggle selection; Shift+Enter to select a range.`" @click="selectionClick(message.id, $event)" @mousedown="selectionPointer" @keydown.enter.self.prevent="selectMessage(message.id, $event.shiftKey)" @keydown.space.self.prevent="selectMessage(message.id, $event.shiftKey)">
              <ProfileAvatar v-if="!grouped(index)" class="message__avatar" :name="message.sender" :picture="conversation.pictures[message.sender]" :assets="assets" :size="NyxSize.Small" />
              <div class="message__body">
                <div v-if="!grouped(index)" class="message__meta">
                  <span class="message__sender">{{ selfName === message.sender ? 'You' : message.sender }}</span>
                  <time :datetime="message.timestamp === null ? undefined : new Date(message.timestamp).toISOString()" :title="dateLabel(message.timestamp, { dateStyle: 'full', timeStyle: 'short' })">{{ dateLabel(message.timestamp, { hour: '2-digit', minute: '2-digit' }) }}</time>
                </div>
                <p v-if="message.text && (query.trim() || !messageLinks(message).includes(message.text.trim()))" class="message__text"><MessageText :text="message.text" :query="query" /></p>
                <LinkPreview v-for="url in messageLinks(message)" :key="url" :url="url" :message="message" :assets="assets" />
                <AttachmentView v-for="(attachment, attachmentIndex) in message.attachments" :key="attachmentIndex" :attachment="attachment" :directory="message.sourceDirectory" :assets="assets" @open="openAsset(`${message.id}-${attachmentIndex}`)" />
                <div v-if="message.reactions.length" class="message__reactions"><span v-for="(reaction, reactionIndex) in message.reactions" :key="reactionIndex" :title="reaction.actor" :aria-label="`${emojiHearts(reaction.emoji)} from ${reaction.actor}`">{{ emojiHearts(reaction.emoji) }}</span></div>
              </div>
            </article>
        </template>
      </div>
    </div>
    <footer class="chat__footer"><NyxIcon name="lock-keyhole" :size="14" aria-hidden="true" /> Read-only archive <ArchiveStatus :text="archiveStatus" /></footer>
  </section>
  <SideShelf v-if="shelfOpen" id="conversation-shelf" title="Conversation information" @close="shelfOpen = false">
    <ConversationInfo v-model:query="query" v-model:extended-messages="extendedMessages" :visible-count="total" :conversation="conversation" :assets="assets" :self-name="selfName" :self-confidence="selfConfidence" :match-count="matches.length" :match-index="match" :selected-message="selectedMessage" :loaded-count="messages.length" :loading-all="loadingAll" @self="emit('self', $event)" @jump="jumpToMessage" @match="showMatch" @view-match="viewMatch" @load-all="loadAll" @open-asset="lightbox = $event" />
  </SideShelf>
  <SideShelf v-if="analysisOpen" id="analysis-shelf" :title="ASK_ECHO_LABEL" icon="sparkles" variant="analysis" :focus-on-open="focusAnalysisOnOpen" @close="analysisOpen = false">
    <ConversationAnalysis :conversation="conversation" :assets="assets" @jump="jumpToMessage" />
  </SideShelf>
  <AssetLightbox v-if="lightbox" :selection="lightbox" :assets="assets" @close="lightbox = undefined" />
  </div>
</template>
