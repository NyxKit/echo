const invalid = () => { throw new Error('invalid_prompt_time') }

export function validatePromptTime(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'sentAt,timeZone' ||
      typeof value.sentAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.sentAt) ||
      typeof value.timeZone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+./-]{0,99}$/.test(value.timeZone)) invalid()
  const date = new Date(value.sentAt)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.sentAt) invalid()
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(date) }
  catch { invalid() }
  return { sentAt: value.sentAt, timeZone: value.timeZone }
}

export function createPromptTime(date = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  return validatePromptTime({ sentAt: date.toISOString(), timeZone })
}

export function promptTimeContext(value) {
  const time = validatePromptTime(value)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: time.timeZone, calendar: 'iso8601', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    fractionalSecondDigits: 3, timeZoneName: 'longOffset',
  })
  const parts = Object.fromEntries(formatter.formatToParts(new Date(time.sentAt)).map(part => [part.type, part.value]))
  const rawOffset = parts.timeZoneName.replace(/^GMT/, '')
  const offset = !rawOffset || rawOffset === '+00:00' ? 'Z' : rawOffset
  return { ...time, localDateTime: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}` }
}
