import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { analysisPreferences } from '../stores/analysis-preferences'

const state = ref<'loading' | 'disconnected' | 'connecting' | 'connected'>('loading')
const working = ref(false)
const error = ref('')
const checked = ref(false)
let popup: Window | null = null
let subscribers = 0
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
  if (polling || !subscribers) return
  polling = true
  try {
    const result = await api('status', 'GET')
    if (!subscribers) return
    error.value = ''
    state.value = ['disconnected', 'connecting', 'connected'].includes(result.state) ? result.state : 'disconnected'
    if (state.value === 'connected') { popup?.close(); popup = null }
  } catch (cause) {
    if (subscribers) { error.value = cause instanceof Error ? cause.message : 'Connection unavailable.'; state.value = 'disconnected' }
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
  try { await api('check'); checked.value = true; await refreshModels() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'The connection check failed.' }
  finally { working.value = false }
}

const models = ref<{ label: string; value: string }[]>([])
const modelsLoading = ref(false)
const modelError = ref('')
let catalogRequest = 0
const connected = computed(() => state.value === 'connected')
const model = computed(() => models.value.some(item => item.value === analysisPreferences.defaultModel) ? analysisPreferences.defaultModel : '')
async function refreshModels() {
  const request = ++catalogRequest
  modelError.value = ''
  if (!connected.value) { models.value = []; modelsLoading.value = false; return }
  modelsLoading.value = true
  try {
    const result = await api('models', 'GET')
    if (request !== catalogRequest) return
    models.value = result.models.map((item: { id: string; name: string }) => ({ value: item.id, label: item.name }))
    if (!analysisPreferences.defaultModel && models.value.length) analysisPreferences.defaultModel = models.value[0].value
    if (!models.value.length) modelError.value = 'ChatGPT returned no available models. Refresh models to try again.'
  } catch (cause) {
    if (request !== catalogRequest) return
    models.value = []; modelError.value = cause instanceof Error ? cause.message : 'Available models could not be loaded.'
  } finally { if (request === catalogRequest) modelsLoading.value = false }
}
const stop = watch(connected, () => { void refreshModels() })
export function useChatGPTConnection() {
  onMounted(() => {
    subscribers++
    if (subscribers !== 1) return
    void refresh()
    poll = setInterval(() => { if (state.value === 'connecting') void refresh() }, 2000)
    window.addEventListener('focus', refresh)
  })
  onUnmounted(() => {
    subscribers--
    if (subscribers) return
    clearInterval(poll); window.removeEventListener('focus', refresh)
  })
  return { state, connected, working, error, checked, models, modelsLoading, modelError, model, refresh, refreshModels, connect, cancel, disconnect, check }
}
if (import.meta.hot) import.meta.hot.dispose(() => { stop(); clearInterval(poll); window.removeEventListener('focus', refresh) })
