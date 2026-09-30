<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { NyxButton, NyxIcon, NyxInput, NyxProgress } from 'nyx-kit/components'
import { useNyxColourMode } from 'nyx-kit/composables'
import { NyxColourMode, NyxSize, NyxTheme, NyxVariant } from 'nyx-kit/types'
import FilterMenu from './components/FilterMenu.vue'
import ArchiveStatus from './components/ArchiveStatus.vue'
import ChatTimeline from './components/ChatTimeline.vue'
import type { ReadingPosition } from './composables/useMessageHistory'
import { conversationPicture, dateLabel, type Archive } from './lib/archive'
import ProfileAvatar from './components/ProfileAvatar.vue'
import { useArchiveStorage } from './composables/useArchiveStorage'
import { useRoute, useRouter } from 'vue-router'
import { conversationPreview } from './lib/message-display'
import { viewerStore } from './stores/viewer'
import { conversationRoutes } from './lib/conversation-routes'
import { clearLinkPreviews } from './lib/link-preview'
import { APP_NAME, APP_BASELINE } from './config'

const { isDark, setMode } = useNyxColourMode()
const route = useRoute()
const router = useRouter()
const input = ref<HTMLInputElement>()
const conversationSearch = ref('')
const category = ref<'Inbox' | 'Requests'>('Inbox')
const categories: { value: 'Inbox' | 'Requests'; label: string }[] = [{ value: 'Inbox', label: 'Inbox' }, { value: 'Requests', label: 'Message requests' }]
const archive = shallowRef<Archive>()
const routeIds = shallowRef(new Map<string, string>())
const selfName = ref('')
const { loading, restoring, saving, forgetting, saved, canForget, progress, error, storageNotice, loadingLabel, load, cancel, forget } = useArchiveStorage(adoptArchive)
const archiveStatus = computed(() => saving.value ? 'Saving archive in this browser…' : saved.value ? 'Saved in this browser' : archive.value ? 'Available for this session' : 'No archive selected')
const positions = new Map<string, ReadingPosition>()
const listLimit = ref(150)
const active = computed(() => archive.value?.conversations.find(conversation => routeIds.value.get(conversation.id) === route.params.id))
const activeId = computed(() => active.value?.id ?? '')
const mobileChat = computed(() => !!active.value)
const inFolder = computed(() => archive.value?.conversations.filter(conversation => category.value === 'Requests' ? conversation.category === 'Requests' : conversation.category !== 'Requests') ?? [])
const filtered = computed(() => {
  const query = conversationSearch.value.trim().toLocaleLowerCase()
  return inFolder.value.filter(conversation => !query || `${conversation.title} ${conversation.participants.join(' ')}`.toLocaleLowerCase().includes(query))
})
const visible = computed(() => filtered.value.slice(0, listLimit.value))

watch(category, () => { listLimit.value = 150 })
watch(active, conversation => {
  if (conversation) category.value = conversation.category === 'Requests' ? 'Requests' : 'Inbox'
})

watch([() => route.params.id, archive], () => {
  if (archive.value && route.name === 'conversation' && !active.value) void router.replace({ name: 'home' })
})

function chooseFolder() { input.value?.click() }
async function loadFolder(event: Event) {
  const field = event.target as HTMLInputElement
  const files = Array.from(field.files ?? [])
  field.value = ''
  await load(files)
}
async function adoptArchive(imported: Archive | undefined, signal?: AbortSignal) {
  const routes = imported ? await conversationRoutes(imported.conversations) : new Map<string, string>()
  signal?.throwIfAborted()
  if (archive.value) clearLinkPreviews(archive.value.assets)
  archive.value = undefined
  await nextTick()
  signal?.throwIfAborted()
  positions.clear()
  routeIds.value = routes
  archive.value = imported
  selfName.value = imported?.selfName ?? ''
  conversationSearch.value = ''
  category.value = 'Inbox'
  listLimit.value = 150
  if (!active.value && route.name !== 'home') await router.replace({ name: 'home' })
}
function openConversation(id: string) {
  const target = routeIds.value.get(id)
  if (target) void router.push({ name: 'conversation', params: { id: target } })
}
function savePosition(value: ReadingPosition, id: string) { positions.set(id, value) }
async function backToList() {
  const previous = route.params.id
  await router.push({ name: 'home' })
  await nextTick()
  if (typeof previous === 'string' && /^[a-f0-9]{64}$/.test(previous)) document.querySelector<HTMLElement>(`[data-conversation-route="${previous}"]`)?.focus()
}
</script>

<template>
  <div class="viewer" :class="{ 'viewer--chat-open': mobileChat }">
    <input ref="input" class="viewer__file-input" type="file" webkitdirectory multiple aria-label="Choose Instagram export folder" tabindex="-1" @change="loadFolder" />
    <aside class="sidebar" aria-label="Conversation browser">
      <header class="sidebar__brand">
        <span class="sidebar__logo" aria-hidden="true"><NyxIcon name="messages-square" :size="23" /></span>
        <h1>{{ APP_NAME }}<span>{{ APP_BASELINE }}</span></h1>
        <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'" @click="setMode(isDark ? NyxColourMode.Light : NyxColourMode.Dark)"><NyxIcon :name="isDark ? 'sun' : 'moon'" :size="19" /></NyxButton>
      </header>
      <div class="sidebar__heading"><h2>Conversations</h2><span v-if="archive">{{ inFolder.length.toLocaleString() }}</span><FilterMenu v-model="category" class="sidebar__folder-menu" label="Conversation folders" :options="categories" /></div>
      <div class="sidebar__search">
        <label class="sr-only" for="conversation-search">Search conversations</label>
        <NyxInput id="conversation-search" v-model="conversationSearch" placeholder="Find a conversation" :disabled="!archive" :size="NyxSize.Small" @keydown.esc="conversationSearch = ''">
          <template #prefix><NyxIcon name="search" :size="17" aria-hidden="true" /></template>
        </NyxInput>
      </div>
      <div v-if="loading" class="sidebar__mobile-notice" role="status">{{ loadingLabel }} <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" @click="cancel">Cancel</NyxButton></div>
      <p v-if="error" class="sidebar__mobile-notice" role="alert">{{ error }}</p>
      <p v-if="storageNotice" class="sidebar__mobile-notice" role="status">{{ storageNotice }}</p>
      <p v-if="archive?.skipped" class="sidebar__mobile-notice" role="status">Some files or records could not be read.</p>
      <nav class="sidebar__list" aria-label="Conversations">
        <template v-if="archive">
          <NyxButton v-for="conversation in visible" :key="conversation.id" class="conversation" :class="{ 'conversation--active': activeId === conversation.id }" :data-conversation-route="routeIds.get(conversation.id)" :variant="NyxVariant.Subtle" :aria-current="activeId === conversation.id ? 'true' : undefined" @click="openConversation(conversation.id)">
            <ProfileAvatar :name="conversation.title" :picture="conversationPicture(conversation, selfName)" :assets="archive.assets" aria-hidden="true" />
            <span class="conversation__content"><span class="conversation__top"><span class="conversation__title">{{ conversation.title }}</span><time v-if="conversation.messages.at(-1)?.timestamp">{{ dateLabel(conversation.messages.at(-1)!.timestamp, { month: 'short', day: 'numeric' }) }}</time></span><span class="conversation__preview">{{ conversationPreview(conversation.messages, viewerStore.extendedMessages) }}</span></span>
          </NyxButton>
          <p v-if="!filtered.length" class="sidebar__empty">No conversations match.<br />Try another name or category.</p>
          <NyxButton v-if="filtered.length > listLimit" class="sidebar__more" :variant="NyxVariant.Subtle" @click="listLimit += 150">Show more conversations</NyxButton>
        </template>
        <div v-else class="sidebar__empty"><NyxIcon name="inbox" :size="26" aria-hidden="true" /><p>Your conversations<br />will appear here.</p><p class="sidebar__mobile-help">{{ APP_BASELINE }}</p><p class="sidebar__mobile-help">Open your extracted JSON export.<br />Saved in this browser. Nothing is uploaded.</p><NyxButton class="sidebar__export" :variant="NyxVariant.Subtle" :size="NyxSize.Small" href="https://accountscenter.facebook.com/info_and_permissions/dyi" rel="noopener noreferrer">Request a new export <NyxIcon name="arrow-up-right" :size="16" aria-hidden="true" /></NyxButton></div>
      </nav>
      <footer class="sidebar__footer">
        <div class="sidebar__actions"><NyxButton :variant="NyxVariant.Soft" :size="NyxSize.Small" :disabled="loading || forgetting" @click="chooseFolder"><NyxIcon name="folder-open" :size="16" aria-hidden="true" /> {{ archive ? 'Change folder' : 'Open folder' }}</NyxButton><NyxButton v-if="canForget" :variant="NyxVariant.Subtle" :size="NyxSize.Small" :loading="forgetting" aria-label="Forget archive" @click="forget">Forget archive</NyxButton></div>
      </footer>
    </aside>
    <main class="workspace">
      <div v-if="loading" class="notice notice--loading" role="status">
        <div><span>{{ loadingLabel }}</span><NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" @click="cancel">Cancel</NyxButton></div>
        <NyxProgress v-if="!restoring" :model-value="progress" :theme="NyxTheme.Primary" />
      </div>
      <div v-if="error" class="notice" role="alert"><span>{{ error }}</span><NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" aria-label="Dismiss error" @click="error = ''"><NyxIcon name="x" :size="18" /></NyxButton></div>
      <div v-if="storageNotice" class="notice" role="status"><NyxIcon name="info" :size="18" aria-hidden="true" /><span>{{ storageNotice }}</span></div>
      <div v-if="archive?.skipped" class="notice" role="status"><NyxIcon name="info" :size="18" aria-hidden="true" /><span>Some files or records could not be read. Available conversations are shown.</span></div>
      <ChatTimeline v-if="active && archive" :key="active.id" :conversation="active" :assets="archive.assets" :self-name="selfName" :self-confidence="archive.selfConfidence" :archive-status="archiveStatus" :position="positions.get(active.id)" @back="backToList" @position="savePosition" @self="selfName = $event" />
      <section v-else class="welcome" :aria-busy="loading">
        <div class="welcome__content">
          <span class="welcome__eyebrow">{{ APP_NAME }}</span>
          <div class="welcome__symbol" aria-hidden="true"><NyxIcon name="messages-square" :size="46" :stroke="1.2" /></div>
          <template v-if="!archive">
            <h2>{{ APP_BASELINE }}</h2>
            <p>Read your Instagram messages, revisit voice notes, and find the things you shared.</p>
            <NyxButton class="welcome__action" :theme="NyxTheme.Primary" :disabled="loading || forgetting" @click="chooseFolder"><NyxIcon name="folder-open" :size="19" aria-hidden="true" /> Open export folder</NyxButton>
            <p class="welcome__hint">Choose your extracted export folder from anywhere on your device.<br />Use a JSON export, not the ZIP file.<br />Your folder is saved in this browser for next time.</p>
            <NyxButton class="welcome__export" :variant="NyxVariant.Subtle" :size="NyxSize.Small" href="https://accountscenter.facebook.com/info_and_permissions/dyi" rel="noopener noreferrer">Request a new export <NyxIcon name="arrow-up-right" :size="16" aria-hidden="true" /></NyxButton>
          </template>
          <template v-else><h2>Pick up a conversation.</h2><p>Choose a chat on the left to explore its messages and shared media.</p></template>
        </div>
        <ArchiveStatus :text="archiveStatus" />
        <p class="welcome__privacy"><NyxIcon name="shield-check" :size="16" aria-hidden="true" /> No uploads. Linked GIFs load from trusted providers.</p>
      </section>
    </main>
  </div>
</template>
