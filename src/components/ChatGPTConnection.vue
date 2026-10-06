<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { NyxButton, NyxIcon } from 'nyx-kit/components'
import { NyxSize, NyxVariant } from 'nyx-kit/types'

const state = ref<'loading' | 'disconnected' | 'connecting' | 'connected'>('loading')
const emit = defineEmits<{ change: [connected: boolean]; checked: [] }>()
watch(state, value => emit('change', value === 'connected'))
const working = ref(false)
const error = ref('')
const checked = ref(false)
let popup: Window | null = null
let disposed = false
let poll: ReturnType<typeof setInterval> | undefined
let polling = false

async function api(action: string, method = 'POST') {
  const response = await fetch(`/api/chatgpt/${action}`, { method, credentials: 'same-origin', cache: 'no-store', headers: { 'X-Echo-Request': '1' } })
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) throw new Error('The local connection service is unavailable. Run Echo with pnpm dev or pnpm preview.')
  const result = await response.json()
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'The connection could not be completed.')
  return result
}
async function refresh() {
  if (polling || disposed) return
  polling = true
  try {
    const result = await api('status', 'GET')
    if (disposed) return
    error.value = ''
    state.value = ['disconnected', 'connecting', 'connected'].includes(result.state) ? result.state : 'disconnected'
    if (state.value === 'connected') { popup?.close(); popup = null }
  } catch (cause) {
    if (!disposed) { error.value = cause instanceof Error ? cause.message : 'Connection unavailable.'; state.value = 'disconnected' }
  } finally { polling = false }
}
async function connect() {
  error.value = ''
  checked.value = false
  working.value = true
  // Open synchronously so browsers treat this as the user's sign-in action.
  popup = window.open('about:blank', '_blank')
  if (popup) popup.opener = null
  try {
    const result = await api('login')
    const url = new URL(result.url)
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize') throw new Error('The sign-in address was not accepted.')
    state.value = 'connecting'
    if (popup) popup.location.href = url.href
    else window.location.assign(url.href)
  } catch (cause) {
    popup?.close(); popup = null
    error.value = cause instanceof Error ? cause.message : 'Sign-in could not start.'
    state.value = 'disconnected'
  } finally { working.value = false }
}
async function cancel() {
  try { await api('cancel-login'); popup?.close(); popup = null; state.value = 'disconnected' }
  catch { error.value = 'Sign-in could not be canceled. Close the sign-in tab and try again.' }
}
async function disconnect() {
  working.value = true; error.value = ''
  try { await api('disconnect'); checked.value = false; state.value = 'disconnected' }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Disconnection failed. Please retry.' }
  finally { working.value = false }
}
async function check() {
  working.value = true; error.value = ''; checked.value = false
  try { await api('check'); checked.value = true; emit('checked') }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'The connection check failed.' }
  finally { working.value = false }
}
onMounted(() => {
  void refresh()
  poll = setInterval(() => { if (state.value === 'connecting') void refresh() }, 2000)
  window.addEventListener('focus', refresh)
})
onUnmounted(() => { disposed = true; clearInterval(poll); window.removeEventListener('focus', refresh) })
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
