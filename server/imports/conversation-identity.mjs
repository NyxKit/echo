import { logicalPath } from './limits.mjs'

export function conversationIdentity(directory) {
  if (typeof directory !== 'string') return null
  let path
  try { path = logicalPath(directory) } catch { return null }
  const folder = path.split('/').at(-1)
  if (/^\d+$/.test(folder)) return { handle: '', sourceId: folder }
  const match = /^(.*)_(\d+)$/.exec(folder)
  return match ? { handle: match[1].toLowerCase(), sourceId: match[2] } : null
}
