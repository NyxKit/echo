export interface Attachment {
  uri: string
  kind: 'image' | 'audio' | 'video' | 'file'
  animated?: boolean
  remote?: boolean
}
export interface ProfilePicture { uri: string; directory: string }
export interface Message {
  id: string
  sender: string
  text: string
  timestamp: number | null
  attachments: Attachment[]
  reactions: { actor: string; emoji: string }[]
  link?: string
  linkPreview?: { title?: string; description?: string; image?: string }
  sourceDirectory: string
}
export interface Conversation {
  id: string
  title: string
  participants: string[]
  category: 'Inbox' | 'Requests' | 'Other'
  messages: Message[]
  pictures: Record<string, ProfilePicture>
  picture?: ProfilePicture
}
export interface Archive {
  conversations: Conversation[]
  assets: AssetIndex
  skipped: number
  selfName: string
  selfConfidence: number
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)

// Some exports encode UTF-8 bytes as Latin-1 Unicode escapes. Leave valid Unicode alone.
export function decodeText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0080-\u00ff]+/g, (sequence) => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(sequence, c => c.charCodeAt(0)))
    } catch { return sequence }
  })
}

export function safePath(value: string): string | undefined {
  let path: string
  try { path = decodeURIComponent(value).replaceAll('\\', '/') } catch { return undefined }
  if (!path || path.startsWith('/') || /[\u0000-\u001f:?#]/.test(path)) return undefined
  const parts = path.split('/').filter(p => p !== '' && p !== '.')
  if (!parts.length || parts.includes('..')) return undefined
  return parts.join('/')
}

export class AssetIndex {
  private files = new Map<string, File>()
  private suffixes = new Map<string, File | null>()
  private root?: string

  constructor(files: Iterable<File>) {
    for (const file of files) {
      const path = safePath(file.webkitRelativePath || file.name)
      if (!path) continue
      this.files.set(path, file)
      const parts = path.split('/')
      // Never resolve by a bare basename: different threads routinely reuse filenames.
      for (let i = 0; i < parts.length - 1; i++) {
        const suffix = parts.slice(i).join('/')
        this.suffixes.set(suffix, this.suffixes.has(suffix) ? null : file)
      }
    }
    const paths = [...this.files.keys()].map(path => path.split('/'))
    if (paths.length && paths.every(parts => parts.length > 1 && parts[0] === paths[0][0])) this.root = paths[0][0]
  }

  resolve(uri: string, directory: string): File | undefined {
    const path = safePath(uri)
    const base = safePath(directory)
    if (!path) return undefined
    const local = base ? this.files.get(`${base}/${path}`) : undefined
    if (local) return local
    const direct = this.files.get(path)
    if (direct) return direct
    const rooted = this.root ? this.files.get(`${this.root}/${path}`) : undefined
    if (rooted) return rooted
    // Only archive-root references may resolve by suffix. A missing thread-local
    // reference must not fall back to another thread's identically named file.
    const parts = path.split('/')
    const section = parts.indexOf('messages')
    if (section >= 0) {
      return this.suffixes.get(parts.slice(section).join('/')) ?? undefined
    }
    return undefined
  }
}

export function safeLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined
  } catch { return undefined }
}

// Recognize media URLs without requesting provider APIs or scraping linked pages.
export const gifHosts = ['media.giphy.com', 'i.giphy.com', 'media0.giphy.com', 'media1.giphy.com', 'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com', 'media.tenor.com', 'c.tenor.com', 'media.tenor.co']

export function gifUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined
    if (gifHosts.includes(url.hostname) && /^\/[a-zA-Z0-9/_~.-]+\.gif$/i.test(url.pathname)) {
      url.search = ''
      url.hash = ''
      return url.href
    }
    if (['giphy.com', 'www.giphy.com', ...gifHosts.filter(host => host.endsWith('.giphy.com'))].includes(url.hostname)) {
      const id = /^\/media\/([a-zA-Z0-9]+)(?:\/|$)/.exec(url.pathname)?.[1]
        ?? /^\/gifs\/(?:.*-)?([a-zA-Z0-9]+)\/?$/.exec(url.pathname)?.[1]
      if (id) return `https://media.giphy.com/media/${id}/giphy.gif`
    }
  } catch { /* Not a remote GIF. */ }
  return undefined
}

export interface SelfIdentity { name: string; confidence: number }

export function inferSelf(conversations: Conversation[]): SelfIdentity {
  const unknown = { name: '', confidence: 0 }
  const chats = conversations.filter(conversation => conversation.participants.length > 0)
  if (chats.length < 2) return unknown
  const common = chats[0].participants.filter(name => name !== 'Unknown sender' && chats.every(chat => chat.participants.includes(name)))
  if (common.length !== 1) return unknown
  // A conservative UI confidence heuristic, not a calibrated probability.
  // Repeated threads with the same people must not inflate the evidence.
  const groups = new Set(chats.map(chat => JSON.stringify([...new Set(chat.participants)].sort()))).size
  const confidence = Math.min(0.999, 1 - 0.2 * 0.5 ** (groups - 1))
  return { name: common[0], confidence }
}

function profilePicture(value: unknown, directory: string): ProfilePicture | undefined {
  if (!record(value)) return undefined
  for (const key of ['profile_picture', 'profile_photo', 'avatar', 'photo', 'thread_image', 'thread_photo']) {
    const candidate = value[key]
    const uri = typeof candidate === 'string' ? candidate : record(candidate) && typeof candidate.uri === 'string' ? candidate.uri : undefined
    if (uri && safePath(uri)) return { uri, directory }
  }
  return undefined
}

export function conversationPicture(conversation: Conversation, selfName: string): ProfilePicture | undefined {
  if (conversation.picture) return conversation.picture
  const others = conversation.participants.filter(name => name !== selfName)
  return others.length === 1 ? conversation.pictures[others[0]] : undefined
}

function accountMetadata(value: RecordValue, directory: string): { name: string; picture?: ProfilePicture } | undefined {
  for (const key of ['owner', 'account_owner']) {
    if (record(value[key])) {
      const owner = value[key] as RecordValue
      const name = decodeText(owner.name) || decodeText(owner.full_name) || decodeText(owner.username)
      if (name) return { name, picture: profilePicture(owner, directory) }
    }
  }
  if (Array.isArray(value.profile_user)) {
    for (const profile of value.profile_user) {
      if (!record(profile) || !record(profile.string_map_data)) continue
      const fields = profile.string_map_data
      const name = decodeText(record(fields.Name) ? fields.Name.value : undefined)
        || decodeText(record(fields.Username) ? fields.Username.value : undefined)
      const media = record(profile.media_map_data) ? profile.media_map_data : undefined
      const image = media?.['Profile Photo'] ?? media?.['Profile Picture']
      const uri = record(image) && typeof image.uri === 'string' && safePath(image.uri) ? image.uri : undefined
      if (name) return { name, picture: uri ? { uri, directory } : undefined }
    }
  }
  return undefined
}

function normalizeMessage(raw: unknown, directory: string, fileIndex: number, index: number): Message | undefined {
  if (!record(raw)) return undefined
  const hasContent = ['content', 'photos', 'videos', 'audio_files', 'files', 'gifs', 'sticker', 'share', 'is_unsent', 'type'].some(key => key in raw)
  if (!hasContent && typeof raw.sender_name !== 'string') return undefined
  const attachments: Attachment[] = []
  const fields = { photos: 'image', videos: 'video', audio_files: 'audio', files: 'file', gifs: 'image' } as const
  for (const [key, kind] of Object.entries(fields)) {
    const values = raw[key]
    if (!Array.isArray(values)) continue
    for (const item of values) {
      const uri = typeof item === 'string' ? item : record(item) && typeof item.uri === 'string' ? item.uri : undefined
      if (uri) {
        const remoteGif = gifUrl(uri)
        attachments.push({ uri: remoteGif ?? uri, kind, animated: key === 'gifs' || /\.gif$/i.test(uri), remote: !!remoteGif })
      }
    }
  }
  if (record(raw.sticker) && typeof raw.sticker.uri === 'string') attachments.push({ uri: raw.sticker.uri, kind: 'image' })
  const timestamp = typeof raw.timestamp_ms === 'number' && Number.isFinite(raw.timestamp_ms) && Math.abs(raw.timestamp_ms) <= 8.64e15
    ? raw.timestamp_ms : null
  const share = record(raw.share) ? raw.share : undefined
  let text = decodeText(raw.content) || decodeText(share?.share_text) || (raw.is_unsent ? 'Message unsent' : '')
  let link = safeLink(share?.link)
  const addGif = (uri: string, remote: boolean) => {
    if (!attachments.some(a => a.uri === uri)) attachments.push({ uri, kind: 'image', animated: true, remote })
  }
  // A message consisting of a local GIF reference is an attachment, not prose.
  if (/^[^\s<>]+\.gif$/i.test(text.trim()) && safePath(text.trim()) && text.trim().includes('/')) {
    addGif(text.trim(), false)
    text = ''
  } else {
    text = text.replace(/https:\/\/[^\s<>"']+/g, value => {
      const suffix = /[),.!;]+$/.exec(value)?.[0] ?? ''
      const candidate = suffix ? value.slice(0, -suffix.length) : value
      const gif = gifUrl(candidate)
      if (!gif) return value
      addGif(gif, true)
      return suffix
    }).trim()
  }
  const sharedGif = link && gifUrl(link)
  if (sharedGif) { addGif(sharedGif, true); link = undefined }
  return {
    id: `${fileIndex}-${index}`,
    sender: decodeText(raw.sender_name) || 'Unknown sender',
    text: text || (!attachments.length && !share ? 'Message content unavailable' : ''),
    timestamp,
    attachments,
    link,
    linkPreview: link && share ? {
      title: decodeText(share.title).slice(0, 300) || undefined,
      description: decodeText(share.description).slice(0, 600) || undefined,
      image: [share.thumbnail, share.image].map(value => typeof value === 'string' ? value : record(value) ? value.uri : undefined)
        .find((value): value is string => typeof value === 'string' && !!safePath(value)),
    } : undefined,
    sourceDirectory: directory,
    reactions: Array.isArray(raw.reactions) ? raw.reactions.filter(record).map(r => ({ actor: decodeText(r.actor), emoji: decodeText(r.reaction) })).filter(r => r.emoji) : [],
  }
}

export async function importArchive(files: File[], progress: (done: number, total: number) => void = () => {}, signal?: AbortSignal): Promise<Archive> {
  const json = files.filter(f => f.name.toLowerCase().endsWith('.json')).sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, 'en', { numeric: true }))
  const conversations = new Map<string, Conversation>()
  const owners = new Map<string, ProfilePicture | undefined>()
  let skipped = 0
  for (let fileIndex = 0; fileIndex < json.length; fileIndex++) {
    signal?.throwIfAborted()
    const file = json[fileIndex]
    const path = safePath(file.webkitRelativePath || file.name)
    if (!path) { skipped++; continue }
    const directory = path.split('/').slice(0, -1).join('/')
    try {
      const value: unknown = JSON.parse(await file.text())
      signal?.throwIfAborted()
      if (record(value)) {
        const owner = accountMetadata(value, directory)
        if (owner) owners.set(owner.name, owner.picture ?? owners.get(owner.name))
      }
      if (record(value) && Array.isArray(value.messages) && (Array.isArray(value.participants) || typeof value.title === 'string')) {
        const participants = Array.isArray(value.participants) ? value.participants.filter(record).map(p => decodeText(p.name)).filter(Boolean) : []
        const conversation = conversations.get(directory) ?? {
          id: directory,
          title: decodeText(value.title) || participants.join(', ') || 'Untitled conversation',
          participants: [],
          category: /(?:^|\/)(?:message_requests|filtered_threads)(?:\/|$)/.test(directory) ? 'Requests' : /(?:^|\/)inbox(?:\/|$)/.test(directory) ? 'Inbox' : 'Other',
          messages: [],
          pictures: Object.create(null) as Record<string, ProfilePicture>,
          picture: profilePicture(value, directory),
        }
        conversation.picture ??= profilePicture(value, directory)
        if (Array.isArray(value.participants)) {
          for (const person of value.participants.filter(record)) {
            const name = decodeText(person.name)
            const picture = profilePicture(person, directory)
            if (name && picture) conversation.pictures[name] = picture
            if (name && person.is_self === true) owners.set(name, picture ?? owners.get(name))
          }
        }
        conversation.participants = [...new Set([...conversation.participants, ...participants])]
        for (let index = 0; index < value.messages.length; index++) {
          const message = normalizeMessage(value.messages[index], directory, fileIndex, index)
          if (message) conversation.messages.push(message)
          else skipped++
        }
        conversations.set(directory, conversation)
      }
    } catch {
      signal?.throwIfAborted()
      skipped++
    }
    progress(fileIndex + 1, json.length)
    if (fileIndex % 15 === 0) await new Promise(resolve => setTimeout(resolve, 0))
  }
  signal?.throwIfAborted()
  for (const conversation of conversations.values()) {
    conversation.messages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.id.localeCompare(b.id, 'en', { numeric: true }))
    conversation.participants = [...new Set([...conversation.participants, ...conversation.messages.map(message => message.sender)])]
    for (const [name, picture] of owners) if (picture && conversation.participants.includes(name)) conversation.pictures[name] ??= picture
  }
  const names = new Set([...conversations.values()].flatMap(conversation => conversation.participants))
  const candidates = [...owners.keys()].filter(name => names.has(name))
  const identity = candidates.length === 1 ? { name: candidates[0], confidence: 1 }
    : candidates.length === 0 ? inferSelf([...conversations.values()]) : { name: '', confidence: 0 }
  return {
    conversations: [...conversations.values()].sort((a, b) => (b.messages.at(-1)?.timestamp ?? 0) - (a.messages.at(-1)?.timestamp ?? 0)),
    assets: new AssetIndex(files),
    skipped,
    selfName: identity.name,
    selfConfidence: identity.confidence,
  }
}

export function preview(message?: Message): string {
  return message?.text || (message?.attachments.length ? 'Shared an attachment' : message?.link ? 'Shared a link' : 'No messages')
}

export function dateLabel(timestamp: number | null, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  return timestamp === null ? 'Date unavailable' : new Intl.DateTimeFormat(undefined, options).format(timestamp)
}
