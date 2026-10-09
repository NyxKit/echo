<script setup lang="ts">
import { ref, watch } from 'vue'
import { NyxAccordion, NyxButton } from 'nyx-kit/components'
import { NyxSize, NyxVariant } from 'nyx-kit/types'
import { createLibraryApi } from '../lib/library-api'
const props = defineProps<{ messageId: string; count: number; assetConflicts: number }>()
const open = ref(''), items = ref<{ id: string; cursor: number; sourceJson: string; assets: { slot: number; assetId: string; kind: string }[] }[]>([]), busy = ref(false), error = ref(''), more = ref(true)
async function load() {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const result = await createLibraryApi().messageVersions(props.messageId, items.value.at(-1)?.cursor ?? 0)
    items.value.push(...result.items); more.value = result.items.length === 20
  } catch { error.value = 'Source versions could not be loaded. Try again.' }
  finally { busy.value = false }
}
watch(open, value => { if (value && !items.value.length) void load() })
</script>
<template>
  <NyxAccordion v-model="open" class="message-versions" :items="[{ id: 'versions', label: assetConflicts ? 'Conflicting source observations' : `${count} source versions` }]" :size="NyxSize.Small" @click.stop>
    <template #item-versions>
      <p>These observations disagree. The first stored version is shown in the timeline; import order does not establish which is newer.</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <ol><li v-for="item in items" :key="item.id"><pre>{{ item.sourceJson }}</pre><ul v-if="assetConflicts"><li v-for="(asset, index) in item.assets" :key="asset.assetId"><a :href="createLibraryApi().assetUrl(asset.assetId)" target="_blank" rel="noopener">Attachment {{ asset.slot + 1 }}, observation {{ index + 1 }}</a></li></ul></li></ol>
      <NyxButton v-if="more || error" :variant="NyxVariant.Subtle" :size="NyxSize.Small" :loading="busy" @click="load">{{ error ? 'Retry' : 'Load source versions' }}</NyxButton>
    </template>
  </NyxAccordion>
</template>
<style scoped lang="scss">
.message-versions {
  margin-top: 8px; font-size: .75rem; max-width: 36rem;
  p { color: var(--nyx-c-text-2); line-height: 1.5; }
  ol { padding-left: 20px; } pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .7rem; max-height: 16rem; overflow: auto; }
}
</style>
