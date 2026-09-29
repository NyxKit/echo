<script setup lang="ts">
import FilterMenu from './FilterMenu.vue'
import { assetTypes, type AssetType } from '../lib/asset-types'
const selected = defineModel<AssetType>({ required: true })
</script>

<template><FilterMenu v-model="selected" label="Filter shared assets" :options="assetTypes" /></template>
