<script setup lang="ts">
import { NyxButton, NyxIcon } from 'nyx-kit/components'
import { NyxSize, NyxVariant } from 'nyx-kit/types'
import { useChatGPTConnection } from '../composables/useChatGPTConnection'
const { state, working, error, checked, connect, cancel, disconnect, check } = useChatGPTConnection()
</script>

<template>
  <section class="chatgpt-connection" aria-label="ChatGPT connection">
    <div class="chatgpt-connection__heading"><NyxIcon name="message-circle" :size="20" aria-hidden="true" /><h3>ChatGPT</h3></div>
    <p v-if="error" class="chatgpt-connection__error" role="alert">{{ error }}</p>
    <p v-if="state === 'loading'" role="status">Checking connection…</p>
    <template v-else-if="state === 'connected'">
      <p role="status">{{ checked ? 'Connection checked. ChatGPT can respond.' : 'Connected to ChatGPT.' }}</p>
      <p>Signing in does not share your archive. Messages send only when you press Enter or the send button. The composer shows which conversation context is included.</p>
      <div class="chatgpt-connection__actions">
        <NyxButton :variant="NyxVariant.Soft" :size="NyxSize.Small" :disabled="working" :loading="working" @click="check">Check connection</NyxButton>
        <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" :disabled="working" @click="disconnect">Disconnect</NyxButton>
        <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" :disabled="working" @click="connect">Reconnect</NyxButton>
      </div>
      <p class="chatgpt-connection__note">Check connection sends a short sample prompt and uses your ChatGPT plan capacity. It contains no archive content.</p>
      <p class="chatgpt-connection__note">Disconnect removes the local login. You can also revoke Echo in <a href="https://chatgpt.com/settings" target="_blank" rel="noopener noreferrer">ChatGPT settings</a>.</p>
    </template>
    <template v-else-if="state === 'connecting'">
      <p role="status">Finish signing in in the ChatGPT tab, then return here.</p>
      <NyxButton :variant="NyxVariant.Subtle" :size="NyxSize.Small" @click="cancel">Cancel sign-in</NyxButton>
    </template>
    <template v-else>
      <p>Connect your ChatGPT account to prepare conversation analysis. Eligible plans can provide access without a separate API key.</p>
      <NyxButton :variant="NyxVariant.Soft" :disabled="working" :loading="working" @click="connect">Continue with ChatGPT</NyxButton>
      <p class="chatgpt-connection__note">Your browser opens ChatGPT for sign-in. Echo keeps the login in your operating system's secure credential store. No messages or images are sent when you connect.</p>
    </template>
  </section>
</template>
