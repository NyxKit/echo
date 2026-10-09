// Work on validated JSON text so large numeric literals and escaped strings stay intact.
export function compactJson(text) {
  const chunks = []
  let start = 0, quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '\\') i++
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
      if (start < i) chunks.push(text.slice(start, i))
      start = i + 1
    }
  }
  chunks.push(text.slice(start))
  return chunks.join('')
}

function entries(text) {
  const values = []
  let start = 1, depth = 0, quoted = false
  for (let i = 1; i < text.length - 1; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '\\') i++
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '[' || char === '{') depth++
    else if (char === ']' || char === '}') depth--
    else if (char === ',' && depth === 0) { values.push(text.slice(start, i)); start = i + 1 }
  }
  if (start < text.length - 1) values.push(text.slice(start, -1))
  return values
}

function field(entry) {
  let end = 1
  while (end < entry.length) {
    if (entry[end] === '\\') end += 2
    else if (entry[end++] === '"') break
  }
  return [JSON.parse(entry.slice(0, end)), entry.slice(end + 1)]
}

// The caller validates the JSON document first. Keep numeric literals and
// unknown members intact rather than re-serializing parsed message objects.
export function sourceMessageRecords(source) {
  const members = entries(compactJson(source)).map(field)
  const messages = members.findLast(([key]) => key === 'messages')?.[1]
  if (!messages || messages[0] !== '[') throw new Error('invalid_source')
  return entries(messages)
}

export function scopedSourceParts(sourceParts, contexts) {
  if (contexts.some(context => context.scope === 'full')) return sourceParts.map(compactJson)
  const references = new Set(contexts.flatMap(context => context.references ?? []))
  return sourceParts.map((source, part) => {
    const compact = compactJson(source)
    const members = entries(compact).map(field)
    // JSON.parse uses the last duplicate member, so keep the same interpretation.
    const messages = members.findLast(([key]) => key === 'messages')?.[1]
    if (!messages || messages[0] !== '[') throw new Error('invalid_analysis')
    const included = entries(messages).flatMap((message, index) => references.has(`p${part + 1}:m${index + 1}`) ? [`"${index}":${message}`] : [])
    // Original indexes are keys, not renumbered array positions. Unrelated metadata is excluded.
    return `{"messages":{${included.join(',')}}}`
  })
}

export function sourceText(sourceParts) {
  return `{"sourceParts":[${sourceParts.map((json, index) => `{"part":${index + 1},"json":${compactJson(json)}}`).join(',')}]}`
}

// Preserve original metadata values, including large numeric literals, while
// moving observed records into the accumulated library context envelope.
export function sourceMetadata(source) {
  return `{${entries(compactJson(source)).filter(entry => field(entry)[0] !== 'messages').join(',')}}`
}

// Raw fields and sparse records are used to verify portable immutable snapshots.
export function sourceFields(source) { return Object.fromEntries(entries(compactJson(source)).map(field)) }
export function sourceRecordEntries(source) {
  const messages = sourceFields(source).messages
  if (!messages) throw new Error('invalid_source')
  return messages[0] === '[' ? entries(messages).map((value,index) => [String(index),value]) : entries(messages).map(field)
}

export function sourceArrayEntries(source) { return entries(compactJson(source)) }
