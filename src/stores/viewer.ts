import { reactive, watch } from 'vue'

const shelfKey = 'meta-chat:shelf-open'
const developerKey = 'meta-chat:developer-mode'
function savedDeveloperMode(): boolean {
  if (!import.meta.env.DEV) return false
  try { return localStorage.getItem(developerKey) === 'true' }
  catch { return false }
}
function savedShelfState(): boolean {
  try { return localStorage.getItem(shelfKey) === 'true' }
  catch { return false }
}

export const viewerStore = reactive({
  shelfOpen: savedShelfState(),
  analysisOpen: false,
  extendedMessages: false,
  developerMode: savedDeveloperMode(),
})

const stop = watch(() => viewerStore.shelfOpen, open => {
  if (open) viewerStore.analysisOpen = false
  try { localStorage.setItem(shelfKey, String(open)) }
  catch { /* Keep the session usable if browser preferences cannot be saved. */ }
}, { flush: 'sync' })

const stopAnalysis = watch(() => viewerStore.analysisOpen, open => {
  if (open) viewerStore.shelfOpen = false
}, { flush: 'sync' })

if (import.meta.hot) import.meta.hot.dispose(() => { stop(); stopAnalysis() })

if (import.meta.env.DEV) {
  const stopDeveloper = watch(() => viewerStore.developerMode, enabled => {
    try { localStorage.setItem(developerKey, String(enabled)) }
    catch { /* Keep the preference in memory if storage is unavailable. */ }
  }, { flush: 'sync' })
  if (import.meta.hot) import.meta.hot.dispose(stopDeveloper)
}
