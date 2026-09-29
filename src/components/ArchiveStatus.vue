<script setup lang="ts">
import { NyxIcon } from 'nyx-kit/components'
defineProps<{ text: string }>()
</script>

<template><span class="archive-status" role="status"><NyxIcon name="folder" :size="14" aria-hidden="true" />{{ text }}</span></template>
