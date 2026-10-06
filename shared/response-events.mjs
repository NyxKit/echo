export async function* responseEvents(body, maxBytes = 8_000_000) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let bytes = 0
  function parse(block) {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    return data && data !== '[DONE]' ? JSON.parse(data) : undefined
  }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new Error('response_limit')
      pending += decoder.decode(chunk.value, { stream: true })
      pending = pending.replaceAll('\r\n', '\n')
      let boundary
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const event = parse(pending.slice(0, boundary))
        pending = pending.slice(boundary + 2)
        if (event) yield event
      }
    }
    pending += decoder.decode()
    if (pending.trim()) { const event = parse(pending); if (event) yield event }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
