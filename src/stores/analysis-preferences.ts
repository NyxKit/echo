import { reactive, watch } from 'vue'
import { contextChoices } from '../../shared/context-windows.mjs'
import { isAnalysisModel, type ContextScope } from '../../shared/analysis-policy.mjs'
const key = 'echo:analysis-preferences'
function restore(): { defaultContext: ContextScope; defaultModel: string } {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    return { defaultContext: contextChoices.includes(value.defaultContext) ? value.defaultContext : 'week', defaultModel: isAnalysisModel(value.defaultModel) ? value.defaultModel : '' }
  } catch { return { defaultContext: 'week', defaultModel: '' } }
}
export const analysisPreferences = reactive(restore())
const stop = watch(analysisPreferences, value => {
  try { localStorage.setItem(key, JSON.stringify(value)) }
  catch { /* Keep non-sensitive defaults for this session if storage is unavailable. */ }
}, { flush: 'sync' })
if (import.meta.hot) import.meta.hot.dispose(stop)
