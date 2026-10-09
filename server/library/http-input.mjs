export async function readBytes(req, limit) {
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new Error('request_too_large')
  const chunks = []
  let length = 0
  const timeout = setTimeout(() => req.destroy(), 5000)
  try {
    for await (const chunk of req) {
      length += chunk.length
      if (length > limit) throw new Error('request_too_large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  } finally { clearTimeout(timeout) }
}

export function bodyless(req) {
  if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) throw new Error('invalid_request')
}

export function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

export async function readBody(req, limit) { return (await readBytes(req, limit)).toString('utf8') }
