import { reactive, watch } from 'vue'

const shelfKey = 'meta-chat:shelf-open'
function savedShelfState(): boolean {
  try { return localStorage.getItem(shelfKey) === 'true' }
  catch { return false }
}

export const viewerStore = reactive({
  shelfOpen: savedShelfState(),
  extendedMessages: false,
})

const stop = watch(() => viewerStore.shelfOpen, open => {
  try { localStorage.setItem(shelfKey, String(open)) }
  catch { /* Keep the session usable if browser preferences cannot be saved. */ }
}, { flush: 'sync' })

if (import.meta.hot) import.meta.hot.dispose(stop)
