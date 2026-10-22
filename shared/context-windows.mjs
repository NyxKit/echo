const day = 24 * 60 * 60 * 1000
const month = 30 * day
export const timeWindows = Object.freeze({ '24h': day, '48h': 2 * day, week: 7 * day, month, '3months': 3 * month, '6months': 6 * month, year: 365 * day })
export const contextChoices = [...Object.keys(timeWindows), 'full', 'selected']
export const isTimeScope = scope => Object.hasOwn(timeWindows, scope)
export function contextLabel(scope, attached = false) {
  if (isTimeScope(scope)) {
    const label = { '3months': '3 months', '6months': '6 months' }[scope] ?? scope
    return `${attached ? 'Surrounding' : 'Last'} ${label}`
  }
  return ({ full: 'All time', selected: 'Only selected messages', surrounding: 'Surrounding messages', discussion: 'Existing discussion' })[scope] ?? scope
}

const validTimestamp = value => Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15

// Accept elapsed milliseconds so presets and future custom durations share one rule.
export function resolveTimeWindows(messages, selectedIndexes, duration) {
  if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error('invalid_context_window')
  let earliest = Infinity, latest = -Infinity
  for (const message of messages) if (validTimestamp(message.timestamp)) {
    earliest = Math.min(earliest, message.timestamp)
    latest = Math.max(latest, message.timestamp)
  }
  const selected = new Set(selectedIndexes)
  let windows
  if (selected.size) {
    const width = Math.min(duration, latest - earliest)
    windows = [...selected].flatMap(index => {
      const timestamp = messages[index]?.timestamp
      if (!validTimestamp(timestamp)) return []
      const start = Math.min(Math.max(timestamp - Math.floor(width / 2), earliest), latest - width)
      return [[start, start + width]]
    })
  } else {
    if (!Number.isFinite(latest)) throw new Error('context_timestamps_unavailable')
    windows = [[latest - duration, latest]]
  }
  windows.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const window of windows) {
    const last = merged.at(-1)
    if (last && window[0] <= last[1]) last[1] = Math.max(last[1], window[1])
    else merged.push([...window])
  }
  return merged
}

export function timeWindowIndexes(messages, selectedIndexes, scope) {
  if (!isTimeScope(scope)) throw new Error('invalid_context_window')
  const merged = resolveTimeWindows(messages, selectedIndexes, timeWindows[scope])
  const selected = new Set(selectedIndexes)
  return messages.flatMap((message, index) => {
    if (selected.has(index)) return [index]
    if (!validTimestamp(message.timestamp)) return []
    // Binary search keeps distant multi-selection windows inexpensive.
    let low = 0, high = merged.length
    while (low < high) { const mid = (low + high) >>> 1; if (merged[mid][0] <= message.timestamp) low = mid + 1; else high = mid }
    return low && message.timestamp <= merged[low - 1][1] ? [index] : []
  })
}
