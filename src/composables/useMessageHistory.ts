import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { Message } from '../lib/archive'

export interface ReadingPosition { start: number; top: number; anchor?: string; offset?: number; bottom?: boolean }
const batchSize = 80
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

export function useMessageHistory(source: Ref<Message[]>, timeline: Ref<HTMLElement | undefined>, initial: ReadingPosition | undefined, save: (position: ReadingPosition) => void) {
  const all = () => source.value
  const start = ref(Math.max(0, Math.min(initial?.start ?? all().length - batchSize, Math.max(0, all().length - 1))))
  const initialAnchor = initial?.anchor ? all().findIndex(message => message.id === initial.anchor) : -1
  if (initialAnchor >= 0) start.value = Math.min(start.value, initialAnchor)
  const messages = computed(() => all().slice(start.value))
  const loading = ref(false)
  const loadingAll = ref(false)
  let mounted = false
  let disposed = false
  let moving = false
  let queue = Promise.resolve()
  let stable: ReadingPosition | undefined
  let resizeObserver: ResizeObserver | undefined
  let restoredTop: number | undefined

  function capture(): ReadingPosition {
    const element = timeline.value
    if (!element?.clientHeight) return stable ?? initial ?? { start: start.value, top: 0 }
    const top = element.getBoundingClientRect().top
    const rows = element.querySelectorAll<HTMLElement>('[data-message-id]')
    let low = 0
    let high = rows.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (rows[middle].getBoundingClientRect().bottom <= top) low = middle + 1
      else high = middle
    }
    const row = rows[low]
    return { start: start.value, top: element.scrollTop, anchor: row?.dataset.messageId, offset: row ? row.getBoundingClientRect().top - top : 0, bottom: element.scrollHeight - element.scrollTop - element.clientHeight < 3 }
  }

  function restore(position: ReadingPosition) {
    const element = timeline.value
    if (!element?.clientHeight) return
    stable = { ...position, start: start.value }
    const anchor = position.anchor && element.querySelector<HTMLElement>(`[data-message-id="${position.anchor}"]`)
    if (position.bottom) element.scrollTop = element.scrollHeight
    else if (anchor) element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - (position.offset ?? 0)
    else element.scrollTop = position.top
    restoredTop = element.scrollTop
  }

  function recordPosition() {
    stable = capture()
    save(stable)
  }

  function run(task: () => Promise<void>) {
    queue = queue.then(async () => {
      if (disposed) return
      moving = true
      try { await task(); await frame() }
      finally {
        moving = false
        if (!disposed) {
          if (stable) restore(stable)
          recordPosition()
        }
      }
    })
    return queue
  }

  async function prepend(nextStart: number) {
    const position = capture()
    start.value = Math.min(start.value, nextStart)
    await nextTick()
    if (!disposed) restore(position)
  }

  async function loadPrevious() {
    if (loading.value || loadingAll.value || start.value === 0 || !mounted) return
    loading.value = true
    try { await run(() => prepend(Math.max(0, start.value - batchSize))) }
    finally { loading.value = false }
  }

  async function loadAll() {
    if (loadingAll.value || start.value === 0) return
    loadingAll.value = true
    try {
      await run(async () => {
        while (start.value > 0 && !disposed) {
          await prepend(Math.max(0, start.value - 400))
          await frame()
        }
      })
    } finally { loadingAll.value = false }
  }

  async function reveal(index: number, focus = false) {
    await run(async () => {
      start.value = Math.min(start.value, Math.max(0, index - 20))
      await nextTick()
      const element = timeline.value
      const target = element?.querySelector<HTMLElement>(`[data-message-id="${all()[index]?.id}"]`)
      if (!element || !target || disposed) return
      element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - (element.clientHeight - target.offsetHeight) / 2
      if (focus) target.focus({ preventScroll: true })
      stable = capture()
    })
  }

  function restoreReadingPosition(position: ReadingPosition) {
    return run(async () => {
      start.value = Math.min(start.value, position.start)
      await nextTick()
      if (!disposed) restore(position)
    })
  }

  watch(source, (current, previous) => {
    const position = capture()
    const firstId = previous[start.value]?.id
    const first = current.findIndex(message => message.id === firstId)
    const anchor = current.findIndex(message => message.id === position.anchor)
    start.value = first >= 0 ? first : Math.max(0, anchor >= 0 ? anchor - 20 : current.length - batchSize)
    void restoreReadingPosition({ ...position, start: start.value })
  })

  function onScroll() {
    if (!mounted || moving || disposed || !timeline.value?.clientHeight) return
    // Do not turn our own restoration into a new reading position if media
    // changes height before its deferred scroll event reaches this handler.
    if (restoredTop !== undefined && Math.abs(timeline.value.scrollTop - restoredTop) < 1) {
      restoredTop = undefined
      return
    }
    restoredTop = undefined
    recordPosition()
    if ((timeline.value?.scrollTop ?? Infinity) < 120) void loadPrevious()
  }

  // Late image/media dimensions should not displace the message being read.
  function onMediaLoad() {
    if (mounted && !moving && stable) restore(stable)
  }

  onMounted(async () => {
    await nextTick()
    restore(initial ?? { start: start.value, top: 0, bottom: true })
    await frame()
    if (!disposed) {
      mounted = true
      if (stable) restore(stable)
      recordPosition()
      const content = timeline.value?.firstElementChild
      if (content) {
        resizeObserver = new ResizeObserver(onMediaLoad)
        resizeObserver.observe(content)
      }
    }
  })
  onBeforeUnmount(() => { disposed = true; resizeObserver?.disconnect(); if (mounted) save(capture()) })
  return { start, messages, loading, loadingAll, capture, restoreReadingPosition, reveal, loadAll, onScroll, onMediaLoad }
}
