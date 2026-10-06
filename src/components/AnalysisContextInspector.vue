<script setup lang="ts">
import { computed } from 'vue'
import { NyxButton, NyxIcon } from 'nyx-kit/components'
import { NyxSize, NyxVariant } from 'nyx-kit/types'
import { analysisRequest, type AnalysisPayload } from '../../shared/analysis-policy.mjs'

const props = defineProps<{ payload: AnalysisPayload; submitted: boolean }>()
const emit = defineEmits<{ close: [] }>()
const turns = computed(() => [...props.payload.history, props.payload.turn])
const images = computed(() => turns.value.flatMap(turn => turn.images))
const exclusions = computed(() => turns.value.flatMap(turn => turn.excluded))
const count = computed(() => props.payload.sourceParts.reduce((sum, part) => sum + Object.values(JSON.parse(part).messages).filter(value => value && typeof value === 'object').length, 0))
const preview = computed(() => JSON.stringify(analysisRequest(props.payload), (key, value) => key === 'image_url' ? '[Image bytes previewed below]' : value, 2))
</script>

<template>
  <section class="analysis-inspector" aria-label="Context inspector">
    <header class="analysis-inspector__header"><h3>{{ submitted ? 'Last submitted request' : 'Prepared request' }}</h3><NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" aria-label="Close context inspector" @click="emit('close')"><NyxIcon name="x" :size="16" /></NyxButton></header>
    <p>{{ payload.turn.context.scope }} · {{ count }} source {{ count === 1 ? 'message' : 'messages' }} · {{ payload.history.length }} completed discussion {{ payload.history.length === 1 ? 'turn' : 'turns' }} · {{ images.length }} images</p>
    <p>Full outgoing text, with image bytes previewed separately. Inspecting does not send anything.</p>
    <pre tabindex="0" aria-label="Full outgoing text context">{{ preview }}</pre>
    <ul v-if="exclusions.length"><li v-for="(item, index) in exclusions" :key="index">{{ item.reference }}: {{ item.reason }}</li></ul>
    <div class="analysis-inspector__images"><figure v-for="(image, index) in images" :key="index"><img :src="image.dataUrl" :alt="`Context image ${index + 1}`" /><figcaption>{{ image.reference }} · {{ image.width }} × {{ image.height }}</figcaption></figure></div>
  </section>
</template>
