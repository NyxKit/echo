<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NyxButton, NyxCard, NyxIcon, NyxMedia } from 'nyx-kit/components'
import { NyxSize, NyxVariant } from 'nyx-kit/types'
import type { AssetIndex, Message } from '../lib/archive'
import { loadLinkPreview, previewEntry, previewUrl } from '../lib/link-preview'
import { useProfilePicture } from '../composables/useProfilePicture'

const props = defineProps<{ url: string; message: Message; assets: AssetIndex; compact?: boolean }>()
const metadata = computed(() => props.url === props.message.link ? props.message.linkPreview : undefined)
const localImage = useProfilePicture(() => metadata.value?.image ? { uri: metadata.value.image, directory: props.message.sourceDirectory } : undefined, () => props.assets)
const state = computed(() => previewEntry(props.assets, props.url).state.value)
const remoteImage = ref('')
watch(() => state.value.image, (blob, _, cleanup) => {
  remoteImage.value = blob ? URL.createObjectURL(blob) : ''
  const url = remoteImage.value
  cleanup(() => { if (url) URL.revokeObjectURL(url) })
}, { immediate: true })
const domain = computed(() => new URL(props.url).hostname)
const title = computed(() => metadata.value?.title || state.value.title)
const description = computed(() => metadata.value?.description || state.value.description)
const image = computed(() => localImage.value || remoteImage.value)
const imageFailed = ref(false)
watch(image, () => { imageFailed.value = false })
</script>

<template>
  <NyxCard class="link-preview" :class="{ 'link-preview--compact': compact }" :size="NyxSize.Small" :variant="NyxVariant.Soft">
    <a class="link-preview__destination" :href="url" target="_blank" rel="noopener noreferrer" :title="url">
      <NyxMedia v-if="image && !imageFailed" class="link-preview__image" :src="image" alt="" @error.capture="imageFailed = true" />
      <span class="link-preview__copy">
        <span class="link-preview__domain">{{ domain }} <NyxIcon name="arrow-up-right" :size="13" aria-hidden="true" /></span>
        <strong v-if="title" class="link-preview__title">{{ title }}</strong>
        <span v-else class="link-preview__url">{{ url }}</span>
        <span v-if="description" class="link-preview__description">{{ description }}</span>
      </span>
    </a>
    <div v-if="!localImage && previewUrl(url)" class="link-preview__action">
      <NyxButton v-if="state.status === 'idle' || state.status === 'loading'" :variant="NyxVariant.Subtle" :size="NyxSize.Small" :loading="state.status === 'loading'" :disabled="state.status === 'loading'" :aria-label="`Load preview from ${domain}`" title="Contacts this website and its preview image host. No cookies or conversation content are sent." @click="loadLinkPreview(assets, url)">Load preview</NyxButton>
      <span v-else-if="state.status === 'unavailable'" role="status">Preview unavailable. Open the link to view it.</span>
    </div>
  </NyxCard>
</template>

<style scoped lang="scss">
.link-preview {
  width: var(--link-preview-width, 23rem);
  max-width: 100%;
  &--compact { width: 100%; }
  overflow: hidden;
  :deep(.nyx-card__body:last-child) { padding: 0; }
  &__destination { display: block; color: inherit; text-decoration: none; }
  &__image { display: block; width: 100%; aspect-ratio: 1.91; overflow: hidden; }
  &__image :deep(img) { width: 100%; height: 100%; object-fit: cover; }
  &__copy { display: flex; flex-direction: column; gap: .35rem; padding: .75rem; overflow-wrap: anywhere; }
  &__domain { display: flex; align-items: center; gap: .4rem; font-size: .75rem; opacity: .7; }
  &__title { font-size: .875rem; line-height: 1.4; }
  &__description, &__url { font-size: .8rem; line-height: 1.5; }
  &__title, &__description, &__url { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  &__action { padding: 0 .5rem .5rem; font-size: .75rem; }
  &__action:empty { display: none; }
  &__action > span { display: block; padding: 0 .25rem; opacity: .7; }
}
</style>
