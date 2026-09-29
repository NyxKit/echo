<script setup lang="ts">
import { NyxAvatar } from 'nyx-kit/components'
import { NyxSize } from 'nyx-kit/types'
import type { AssetIndex, ProfilePicture } from '../lib/archive'
import { useProfilePicture } from '../composables/useProfilePicture'
const props = defineProps<{ name: string; picture?: ProfilePicture; assets: AssetIndex; size?: NyxSize }>()
const url = useProfilePicture(() => props.picture, () => props.assets)
</script>
<template>
  <NyxAvatar :name="name" :src="url || undefined" :placeholder="name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase()" :size="size ?? NyxSize.Medium" @error.capture="url = ''" />
</template>
