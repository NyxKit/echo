import { readFile, writeFile, open } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { importLimits, logicalPath, pathRegistry } from './limits.mjs'

export const digest = value => createHash('sha256').update(value).digest('hex')
export const record = value => !!value && typeof value === 'object' && !Array.isArray(value)
export function decode(value) {
  return typeof value === 'string' ? value.replace(/[\u0080-\u00ff]+/g, part => {
    try { return new TextDecoder('utf8', { fatal: true }).decode(Uint8Array.from(part, c => c.charCodeAt(0))) } catch { return part }
  }) : ''
}
function ownerMetadata(value) {
  const found = []
  for (const key of ['owner', 'account_owner']) if (record(value[key])) {
    const raw = value[key], label = decode(raw.name) || decode(raw.full_name) || decode(raw.username)
    if (label) found.push({ label, stableId: typeof raw.id === 'string' && /^\d{1,30}$/.test(raw.id) ? `instagram:${raw.id}` : null,
      evidence: { kind: key, raw } })
  }
  for (const profile of Array.isArray(value.profile_user) ? value.profile_user : []) {
    const fields = profile?.string_map_data
    if (!record(fields)) continue
    const label = decode(fields.Name?.value) || decode(fields.Username?.value)
    if (label) found.push({ label, stableId: null, evidence: { kind: 'profile_user', raw: fields } })
  }
  for (const person of Array.isArray(value.participants) ? value.participants : []) if (person?.is_self === true && decode(person.name)) {
    found.push({ label: decode(person.name), stableId: null, evidence: { kind: 'participant_self', raw: person } })
  }
  return found
}
export function fileResolver(files) {
  const exact = new Map(files.map(file => [file.path, file])), suffixes = new Map()
  const roots = new Set(files.map(file => file.path.split('/')[0]))
  const root = roots.size === 1 && files.every(file => file.path.includes('/')) ? files[0].path.split('/')[0] : undefined
  for (const file of files) {
    const parts = file.path.split('/'), index = parts.indexOf('messages')
    if (index >= 0) {
      const suffix = parts.slice(index).join('/')
      suffixes.set(suffix, suffixes.has(suffix) ? null : file)
    }
  }
  return (uri, directory) => {
    let path
    try { path = logicalPath(decodeURIComponent(uri)) } catch { return undefined }
    const local = exact.get(`${directory}/${path}`) ?? exact.get(path) ?? (root ? exact.get(`${root}/${path}`) : undefined)
    if (local) return local
    const parts = path.split('/'), index = parts.indexOf('messages')
    return index >= 0 ? suffixes.get(parts.slice(index).join('/')) ?? undefined : undefined
  }
}
export function attachmentReferences(raw) {
  const result = []
  for (const [field, kind] of Object.entries({ photos: 'image', videos: 'video', audio_files: 'audio', files: 'file', gifs: 'image' })) {
    for (const item of Array.isArray(raw[field]) ? raw[field] : []) {
      const uri = typeof item === 'string' ? item : item?.uri
      if (typeof uri === 'string') result.push({ uri, kind })
    }
  }
  if (typeof raw.sticker?.uri === 'string') result.push({ uri: raw.sticker.uri, kind: 'image' })
  const content = decode(raw.content).trim()
  if (/^[^\s<>]+\.gif$/i.test(content) && content.includes('/') && !/^https?:/i.test(content)) result.push({ uri: content, kind: 'image' })
  return result
}

export async function validateExport(directory, files, { limits = importLimits, signal, progress = () => {} } = {}) {
  const registry = pathRegistry(limits), groups = new Map(), owners = new Map(), names = new Set()
  let bytes = 0, completed = 0, html = false
  for (const file of files) {
    file.path = registry.add(file.path)
    if (!/^[a-f0-9-]{36}$/.test(file.id) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > limits.entry) throw new Error('import_invalid')
    bytes += file.size
    if (bytes > limits.expanded) throw new Error('import_limit')
    html ||= /\.html?$/i.test(file.path)
  }
  const jsonFiles = files.filter(file => /\.json$/i.test(file.path)).sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }))
  progress({ phase: 'validating', completed: 0, total: jsonFiles.length })
  for (const file of jsonFiles) {
    signal?.throwIfAborted()
    if (file.size > limits.json) throw new Error('import_limit')
    const source = await readFile(join(directory, file.id), 'utf8')
    let value
    try { value = JSON.parse(source) } catch { throw new Error('import_invalid') }
    if (!record(value)) { progress({ phase: 'validating', completed: ++completed, total: jsonFiles.length }); continue }
    for (const candidate of ownerMetadata(value)) {
      const key = digest(JSON.stringify(candidate.evidence))
      owners.set(key, { ...candidate, evidenceHash: key })
    }
    if (Array.isArray(value.messages)) {
      if (!Array.isArray(value.participants) && typeof value.title !== 'string') throw new Error('import_invalid')
      const directoryPath = file.path.split('/').slice(0, -1).join('/')
      const group = groups.get(directoryPath) ?? { key: randomUUID(), title: decode(value.title) || 'Untitled conversation',
        category: /(?:^|\/)(?:message_requests|filtered_threads)(?:\/|$)/.test(directoryPath) ? 'Requests' : 'Inbox',
        directory: directoryPath, participants: [], parts: [], bytes: 0, messages: 0 }
      const participants = (value.participants ?? []).map(person => decode(person?.name)).filter(Boolean)
      for (const message of value.messages) {
        if (!record(message) || !['sender_name', 'content', 'photos', 'videos', 'audio_files', 'files', 'gifs', 'sticker', 'share', 'is_unsent', 'type'].some(key => key in message)) throw new Error('import_invalid')
        const name = decode(message.sender_name)
        if (name) names.add(name)
      }
      group.participants = [...new Set([...group.participants, ...participants])]
      group.bytes += file.size; group.messages += value.messages.length
      if (group.bytes > 32 * 1024 * 1024 || group.messages > 100_000 || group.parts.length >= 256 || group.participants.length > 1000) throw new Error('import_limit')
      group.parts.push({ ...file, digest: digest(source) })
      groups.set(directoryPath, group)
    }
    progress({ phase: 'validating', completed: ++completed, total: jsonFiles.length })
  }
  if (!groups.size) throw new Error(html ? 'import_html_only' : 'import_no_messages')
  if (groups.size > 10_000) throw new Error('import_limit')
  const conversations = [...groups.values()]
  const common = conversations[0].participants.filter(name => conversations.every(group => group.participants.includes(name)))
  const explicit = [...owners.values()]
  const candidates = [...new Set([...explicit.map(candidate => candidate.label), ...common])]
  if (!candidates.length) candidates.push(...names)
  if (candidates.length > 1000 || explicit.length > 1000) throw new Error('import_limit')
  const plan = { version: 1, files, conversations, owner: { explicit, candidates }, bytes }
  const encoded = JSON.stringify(plan)
  if (Buffer.byteLength(encoded) > 64 * 1024 * 1024) throw new Error('import_limit')
  await writeFile(join(directory, 'plan.json'), encoded, { mode: 0o600, flag: 'wx' })
  const handle = await open(join(directory, 'plan.json'), 'r+')
  try { await handle.sync() } finally { await handle.close() }
  return { conversations: conversations.length, owner: plan.owner, bytes }
}

function pictureUri(value) {
  if (!record(value)) return undefined
  for (const key of ['profile_picture', 'profile_photo', 'avatar', 'photo', 'thread_image', 'thread_photo']) {
    const item = value[key], uri = typeof item === 'string' ? item : item?.uri
    if (typeof uri === 'string') return uri
  }
}
export function profileReferences(value) {
  const pictures = []
  const group = pictureUri(value)
  if (group) pictures.push({ name: '', uri: group })
  for (const person of Array.isArray(value.participants) ? value.participants : []) {
    const uri = pictureUri(person), name = decode(person?.name)
    if (uri && name) pictures.push({ name, uri })
  }
  for (const key of ['owner', 'account_owner']) {
    const uri = pictureUri(value[key]), name = decode(value[key]?.name) || decode(value[key]?.full_name) || decode(value[key]?.username)
    if (uri && name) pictures.push({ name, uri })
  }
  return pictures
}
export function thumbnailReference(raw) {
  for (const item of [raw.share?.thumbnail, raw.share?.image]) {
    const uri = typeof item === 'string' ? item : item?.uri
    if (typeof uri === 'string') return uri
  }
}
