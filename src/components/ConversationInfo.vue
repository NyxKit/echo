<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NyxAccordion, NyxButton, NyxIcon, NyxInput, NyxSwitch } from 'nyx-kit/components'
import { NyxSize, NyxVariant } from 'nyx-kit/types'
import { SELF_CONFIDENCE_THRESHOLD } from '../config'
import { conversationPicture, dateLabel, type AssetIndex, type Conversation, type Message } from '../lib/archive'
import { assetTypes, type AssetType } from '../lib/asset-types'
import AssetFilterMenu from './AssetFilterMenu.vue'
import AttachmentView from './AttachmentView.vue'
import ProfileAvatar from './ProfileAvatar.vue'
import MessageText from './MessageText.vue'
import LinkPreview from './LinkPreview.vue'
import { messageLinks } from '../lib/link-preview'
import MessageJumpButton from './MessageJumpButton.vue'
import { conversationGallery, type GallerySelection } from '../lib/gallery'

const props = defineProps<{ conversation: Conversation; assets: AssetIndex; selfName: string; selfConfidence: number; matchCount: number; matchIndex: number; selectedMessage?: Message; loadedCount: number; visibleCount: number; loadingAll: boolean }>()
const extendedMessages = defineModel<boolean>('extendedMessages', { required: true })
const query = defineModel<string>('query', { required: true })
const emit = defineEmits<{ self: [name: string]; jump: [index: number]; match: [index: number]; 'view-match': []; 'load-all': []; 'open-asset': [selection: GallerySelection] }>()
const sections = [{ id: 'participants', label: 'Participants' }, { id: 'history', label: 'History' }, { id: 'shared', label: 'Shared assets' }]
const openSections = ref<string[]>(sections.map(section => section.id))
const selectedType = ref<AssetType>('media')
const limit = ref(24)
watch(selectedType, () => { limit.value = 24 })
const media = computed(() => props.conversation.messages.flatMap((message, index) => [
  ...message.attachments.map((attachment, attachmentIndex) => ({ id: `${message.id}-${attachmentIndex}`, message, index, attachment, link: undefined as string | undefined })),
  ...messageLinks(message).map((link, linkIndex) => ({ id: `${message.id}-link-${linkIndex}`, message, index, attachment: undefined, link })),
]).reverse())
const filtered = computed(() => media.value.filter(item => {
  const type: AssetType = item.link ? 'links' : item.attachment?.animated ? 'gifs' : item.attachment?.kind === 'image' || item.attachment?.kind === 'video' ? 'media' : item.attachment?.kind ?? 'file'
  return selectedType.value === type
}))
const assetHeading = computed(() => assetTypes.find(type => type.value === selectedType.value)!.label)
const visual = computed(() => selectedType.value === 'media' || selectedType.value === 'gifs')
const dated = computed(() => props.conversation.messages.filter(message => message.timestamp !== null))
function openAsset(id: string) {
  const allowed = new Set(filtered.value.map(item => item.id))
  const items = conversationGallery(props.conversation, props.assets).filter(item => allowed.has(item.id)).reverse()
  const index = items.findIndex(item => item.id === id)
  if (index >= 0) emit('open-asset', { items, index })
}
</script>

<template>
  <div class="conversation-info">
    <section class="conversation-info__summary" aria-label="Conversation summary">
      <ProfileAvatar :name="conversation.title" :picture="conversationPicture(conversation, selfName)" :assets="assets" />
      <h3>{{ conversation.title }}</h3>
      <p>{{ conversation.category }} · {{ conversation.messages.length.toLocaleString() }} messages</p>
      <p v-if="dated.length">{{ dateLabel(dated[0].timestamp) }} – {{ dateLabel(dated.at(-1)!.timestamp) }}</p>
    </section>
    <NyxAccordion v-model="openSections" class="conversation-info__sections" :items="sections" multiple :size="NyxSize.Small">
      <template #header-participants>Participants <span class="conversation-info__count">{{ conversation.participants.length }}</span></template>
      <template #item-participants>
        <section class="conversation-info__people" aria-label="Participants">
          <p v-if="!selfName" class="conversation-info__hint">Choose your name to put your messages on the right.</p>
          <ul>
            <li v-for="name in conversation.participants" :key="name">
              <ProfileAvatar :name="name" :picture="conversation.pictures[name]" :assets="assets" :size="NyxSize.Small" />
              <span class="conversation-info__person">{{ name }}<span v-if="selfName === name">You</span></span>
              <NyxButton v-if="selfName !== name && selfConfidence <= SELF_CONFIDENCE_THRESHOLD" :variant="NyxVariant.Subtle" :size="NyxSize.Small" :aria-label="`Set ${name} as yourself`" @click="emit('self', name)">This is me</NyxButton>
              <NyxIcon v-if="selfName === name && selfConfidence <= SELF_CONFIDENCE_THRESHOLD" name="check" :size="17" aria-label="Your account" />
            </li>
          </ul>
        </section>
      </template>
      <template #item-history>
        <section class="conversation-info__history" aria-label="Conversation history">
          <div class="conversation-info__search">
            <label for="message-search">Search this conversation</label>
            <NyxInput id="message-search" v-model="query" placeholder="Find a message" :size="NyxSize.Small" @keydown.esc.stop.prevent="query = ''" @keydown.enter.prevent="emit('match', matchIndex + 1)">
              <template #prefix><NyxIcon name="search" :size="17" aria-hidden="true" /></template>
            </NyxInput>
            <div v-if="query.trim()" class="conversation-info__results">
              <div class="conversation-info__result-controls">
                <span role="status">{{ matchCount ? `${matchIndex + 1} of ${matchCount}` : 'No matches' }}</span>
                <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" :disabled="!matchCount" aria-label="Previous match" @click="emit('match', matchIndex - 1)"><NyxIcon name="chevron-up" :size="18" /></NyxButton>
                <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" :disabled="!matchCount" aria-label="Next match" @click="emit('match', matchIndex + 1)"><NyxIcon name="chevron-down" :size="18" /></NyxButton>
                <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" aria-label="Clear message search" @click="query = ''"><NyxIcon name="x" :size="17" /></NyxButton>
              </div>
              <div v-if="selectedMessage && matchCount" class="conversation-info__result-preview">
                <div class="conversation-info__result-heading"><p>{{ selectedMessage.sender }} · {{ dateLabel(selectedMessage.timestamp) }}</p><MessageJumpButton label="View search result in conversation" @click="emit('view-match')" /></div>
                <MessageText :text="selectedMessage.text" :query="query" />
              </div>
            </div>
          </div>
          <div class="conversation-info__extended">
            <div><span id="extended-messages-label">Extended messages</span><p id="extended-messages-hint" class="conversation-info__hint">Show attachment notices and reaction activity.</p></div>
            <NyxSwitch v-model="extendedMessages" :size="NyxSize.Small" role="switch" tabindex="0" :aria-checked="extendedMessages" aria-labelledby="extended-messages-label" aria-describedby="extended-messages-hint" @keydown.space.prevent="extendedMessages = !extendedMessages" @keydown.enter.prevent="extendedMessages = !extendedMessages" />
          </div>
          <div class="conversation-info__history-controls">
            <span role="status">{{ loadedCount === visibleCount ? 'All messages loaded' : `${loadedCount.toLocaleString()} of ${visibleCount.toLocaleString()} messages loaded` }}</span>
            <NyxButton :variant="NyxVariant.Soft" :size="NyxSize.Small" :loading="loadingAll" :disabled="loadedCount === visibleCount" @click="emit('load-all')">Load all</NyxButton>
          </div>
        </section>
      </template>
      <template #item-shared>
        <section class="conversation-info__shared" aria-labelledby="shared-media-title">
          <div class="conversation-info__asset-heading"><h4 id="shared-media-title">{{ assetHeading }} <span>{{ filtered.length }}</span></h4><AssetFilterMenu v-model="selectedType" /></div>
          <p v-if="!filtered.length" class="conversation-info__hint">No matching assets in this conversation.</p>
          <ol class="conversation-info__media" :class="{ 'conversation-info__media--visual': visual }">
            <li v-for="item in filtered.slice(0, limit)" :key="item.id">
              <AttachmentView v-if="item.attachment" :attachment="item.attachment" :directory="item.message.sourceDirectory" :assets="assets" @open="openAsset(item.id)" />
              <LinkPreview v-else-if="item.link" :url="item.link" :message="item.message" :assets="assets" compact />
              <MessageJumpButton v-if="visual" class="conversation-info__tile-jump" @click="emit('jump', item.index)" />
              <div v-else class="conversation-info__media-meta"><span>{{ item.message.sender }} · {{ dateLabel(item.message.timestamp) }}</span><MessageJumpButton @click="emit('jump', item.index)" /></div>
            </li>
          </ol>
          <NyxButton v-if="filtered.length > limit" :variant="NyxVariant.Soft" :size="NyxSize.Small" @click="limit += 24">Show more assets</NyxButton>
        </section>
      </template>
    </NyxAccordion>
  </div>
</template>
