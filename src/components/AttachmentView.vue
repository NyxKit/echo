<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NyxButton, NyxIcon, NyxMedia } from 'nyx-kit/components'
import { NyxMediaType, NyxVariant } from 'nyx-kit/types'
import { identifyMedia } from '../lib/media'
import { fetchGif } from '../lib/remote-gif'
import type { AssetIndex, Attachment } from '../lib/archive'

const props = withDefaults(defineProps<{ attachment: Attachment; directory: string; assets: AssetIndex; preview?: boolean }>(), { preview: true })
const emit = defineEmits<{ open: [] }>()
const host = ref<HTMLElement>()
const url = ref('')
const kind = ref<'image' | 'audio' | 'video' | 'file'>('file')
const failed = ref(false)
const ready = ref(false)
const file = props.assets.resolve(props.attachment.uri, props.directory)
const libraryUrl = props.assets.url(props.attachment.uri, props.directory)
const remote = props.attachment.remote === true
const controller = new AbortController()
let observer: IntersectionObserver | undefined
let disposed = false
let started = false
async function load() {
  if (started || (!file && !remote && !libraryUrl)) return
  started = true
  try {
    if (libraryUrl) {
      const response = await fetch(libraryUrl, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'X-Echo-Request': '1' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
      if (!response.ok) throw new Error('unavailable')
      const type = response.headers.get('content-type')?.split('/')[0]
      if (disposed) return
      kind.value = type === 'image' || type === 'video' || type === 'audio' ? type : 'file'
      if (kind.value !== 'file') url.value = libraryUrl
      ready.value = true
      return
    }
    const source = remote ? await fetchGif(props.attachment.uri, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])) : file!
    const detected = remote ? 'image' : await identifyMedia(file!, props.attachment.kind)
    if (disposed) return
    kind.value = detected
    if (detected !== 'file') url.value = URL.createObjectURL(source)
  } catch { failed.value = true }
  ready.value = true
}
watch(ready, async () => {
  await nextTick()
  host.value?.querySelectorAll('audio, video').forEach(media => {
    media.setAttribute('controlslist', 'nodownload')
    media.setAttribute('playsinline', '')
    if (props.preview && media.tagName === 'VIDEO') media.removeAttribute('controls')
  })
})
onMounted(() => {
  if (!file && !remote && !libraryUrl) return
  if (!('IntersectionObserver' in window)) { void load(); return }
  observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void load() }
  }, { rootMargin: '250px' })
  if (host.value) observer.observe(host.value)
})
onBeforeUnmount(() => { disposed = true; controller.abort(); observer?.disconnect(); if (url.value.startsWith('blob:')) URL.revokeObjectURL(url.value) })
</script>

<template>
  <div ref="host" class="attachment" :class="{ 'attachment--gif': attachment.animated }" @error.capture="failed = true">
    <p v-if="!file && !remote && !libraryUrl" class="attachment__missing"><NyxIcon name="file-question" :size="18" aria-hidden="true" /> Attachment unavailable</p>
    <template v-else>
      <p v-if="!ready" class="attachment__loading">Loading attachment…</p>
      <NyxButton v-else-if="!failed && preview && (kind === 'image' || kind === 'video')" class="attachment__preview" :variant="NyxVariant.Subtle" :aria-label="attachment.animated ? 'Open GIF' : kind === 'video' ? 'Open video' : 'Open photo'" @click="emit('open')">
        <NyxMedia class="attachment__media" :type="kind as NyxMediaType" :src="url" :alt="attachment.animated ? 'Animated GIF' : file?.name" />
        <span v-if="kind === 'video'" class="attachment__play" aria-hidden="true"><NyxIcon name="play" :size="26" /></span>
      </NyxButton>
      <NyxMedia v-else-if="!failed && kind !== 'file'" class="attachment__media" :type="kind as NyxMediaType" :src="url" :alt="attachment.animated ? 'Animated GIF' : file?.name" :title="kind === 'audio' || kind === 'video' ? `Play ${kind} attachment` : undefined" />
      <p v-if="failed" class="attachment__missing">{{ remote ? 'GIF unavailable or could not be verified.' : 'Preview unavailable.' }}</p>
      <p v-else-if="ready && kind === 'file'" class="attachment__file"><NyxIcon name="file-text" :size="18" aria-hidden="true" /><span>{{ file?.name }}<small>Preview unavailable</small></span></p>
    </template>
  </div>
</template>
