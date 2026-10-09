const day = 24 * 60 * 60 * 1000
export const timeWindows = Object.freeze({ '24h': day, '48h': 2 * day, week: 7 * day, month: 30 * day, year: 365 * day })
export const contextChoices = [...Object.keys(timeWindows), 'full', 'selected']
export const isTimeScope = scope => Object.hasOwn(timeWindows, scope)
export function contextLabel(scope, attached = false) {
  if (isTimeScope(scope)) return `${attached ? 'Surrounding' : 'Last'} ${scope}`
  return ({ full: 'All time', selected: 'Only selected messages', surrounding: 'Surrounding messages', discussion: 'Existing discussion' })[scope] ?? scope
}

// Work in elapsed milliseconds so windows are identical across time zones and DST.
export function timeWindowIndexes(messages, selectedIndexes, scope) {
  if (!isTimeScope(scope)) throw new Error('invalid_context_window')
  const valid = value => Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15
  const selected = new Set(selectedIndexes)
  let windows
  if (selected.size) {
    windows = [...selected].flatMap(index => {
      const timestamp = messages[index]?.timestamp
      return valid(timestamp) ? [[timestamp - timeWindows[scope] / 2, timestamp + timeWindows[scope] / 2]] : []
    })
  } else {
    let latest = -Infinity
    for (const message of messages) if (valid(message.timestamp)) latest = Math.max(latest, message.timestamp)
    if (!Number.isFinite(latest)) throw new Error('context_timestamps_unavailable')
    windows = [[latest - timeWindows[scope], latest]]
  }
  windows.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const window of windows) {
    const last = merged.at(-1)
    if (last && window[0] <= last[1]) last[1] = Math.max(last[1], window[1])
    else merged.push([...window])
  }
  return messages.flatMap((message, index) => {
    if (selected.has(index)) return [index]
    if (!valid(message.timestamp)) return []
    // Binary search keeps distant multi-selection windows inexpensive.
    let low = 0, high = merged.length
    while (low < high) { const mid = (low + high) >>> 1; if (merged[mid][0] <= message.timestamp) low = mid + 1; else high = mid }
    return low && message.timestamp <= merged[low - 1][1] ? [index] : []
  })
}
