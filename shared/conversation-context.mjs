export function validateBackground(value) {
  const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
  const text = value => typeof value === 'string' && value.length <= 262_144
  if (!value || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.binding) || !Array.isArray(value.notes) || value.notes.length > 10_000) throw new Error('invalid_analysis')
  const seen = new Set()
  const notes = value.notes.map(note => {
    if (!note || !id(note.userId) || !id(note.conversationId) || !Number.isSafeInteger(note.revision) || note.revision < 1 ||
        !['conversation','group','participant'].includes(note.kind) || !text(note.label) || !text(note.markdown) || !note.markdown.trim() ||
        note.kind === 'participant' && (typeof note.participantId !== 'string' || !/^instagram:[1-9]\d{0,29}$/.test(note.participantId)) || seen.has(note.conversationId)) throw new Error('invalid_analysis')
    seen.add(note.conversationId)
    return { userId: note.userId, conversationId: note.conversationId, revision: note.revision, kind: note.kind,
      ...(note.kind === 'participant' ? { participantId: note.participantId } : {}), label: note.label, markdown: note.markdown }
  })
  return { version: 1, binding: value.binding, notes }
}

// NyxEditor accepts Markdown and pasted rich text. Keep HTML and images literal
// before Markdown parsing; the editor is a text/formatting surface only.
export function editorMarkdown(value) {
  const literal = text => text.replace(/</g, '&lt;').replace(/!\[/g, '\\![')
  function line(text) {
    const ticks = /`+/g
    let output = '', cursor = 0, opening
    while ((opening = ticks.exec(text))) {
      // An escaped opening delimiter is ordinary text, not a code span.
      const prefix = text.slice(0, opening.index).match(/\\+$/)?.[0].length ?? 0
      if (prefix % 2) continue
      let closing
      while ((closing = ticks.exec(text)) && closing[0].length !== opening[0].length) { /* Find an exact matching run. */ }
      if (!closing) break
      output += literal(text.slice(cursor, opening.index)) + text.slice(opening.index, ticks.lastIndex)
      cursor = ticks.lastIndex
    }
    return output + literal(text.slice(cursor))
  }
  const inline = text => text.split('\n').map(line).join('\n')
  // Preserve the editor's top-level fenced code and same-line code spans,
  // where HTML/images are already inert. Other syntax is escaped conservatively.
  const fences = /^(`{3,}|~{3,})([^\n]*)\n?/gm
  let output = '', cursor = 0, opening
  while ((opening = fences.exec(value))) {
    if (opening.index && !/\n[ \t]*\r?\n$/.test(value.slice(0, opening.index))) continue
    const marker = opening[1]
    if (marker[0] === '`' && opening[2].includes('`')) continue
    const end = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*(?:\\r?\\n|$)`, 'gm')
    end.lastIndex = fences.lastIndex
    const closing = end.exec(value), until = closing ? end.lastIndex : value.length
    output += inline(value.slice(cursor, opening.index)) + value.slice(opening.index, until)
    cursor = until; fences.lastIndex = until
  }
  return output + inline(value.slice(cursor))
}
