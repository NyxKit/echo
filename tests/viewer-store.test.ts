import { afterEach, describe, expect, it, vi } from 'vitest'
import { toRef } from 'vue'
import { viewerStore } from '../src/stores/viewer'

afterEach(() => {
  viewerStore.shelfOpen = false
  viewerStore.analysisOpen = false
  vi.unstubAllGlobals()
})

describe('mutually exclusive shelves', () => {
  it('switches in both directions synchronously through component bindings and allows both closed', () => {
    const info = toRef(viewerStore, 'shelfOpen')
    const analysis = toRef(viewerStore, 'analysisOpen')
    info.value = true
    expect(analysis.value).toBe(false)
    analysis.value = true
    expect(info.value).toBe(false)
    info.value = true
    expect(analysis.value).toBe(false)
    info.value = false
    expect([info.value, analysis.value]).toEqual([false, false])
    analysis.value = true
    analysis.value = false
    expect([info.value, analysis.value]).toEqual([false, false])
  })

  it('persists Information closing when Ask Echo opens, including unavailable browser storage', () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { setItem })
    viewerStore.shelfOpen = true
    viewerStore.analysisOpen = true
    expect(setItem).toHaveBeenLastCalledWith('meta-chat:shelf-open', 'false')
    setItem.mockImplementation(() => { throw new Error('Storage unavailable') })
    viewerStore.shelfOpen = true
    expect(viewerStore.analysisOpen).toBe(false)
    viewerStore.analysisOpen = true
    expect(viewerStore.shelfOpen).toBe(false)
  })
})
