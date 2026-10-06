import type { AssetIndex, Conversation, Message } from './archive'
import { identifyMedia } from './media'
import { validateAnalysis, type AnalysisContext, type ContextScope, type AnalysisImage, type AnalysisInput, type AnalysisPayload } from '../../shared/analysis-policy.mjs'
import { scopedSourceParts } from '../../shared/analysis-source.mjs'

export function messageReference(message: Message): string | undefined {
  const ref = message.sourceReference
  return ref ? `p${ref.part + 1}:m${ref.index + 1}` : undefined
}
export async function sourceVersion(conversation: Conversation): Promise<string> {
  if (!conversation.sourceComplete || !conversation.sourceParts?.length) throw new Error('The source conversation is incomplete. Import a complete export before analysis.')
  return contextVersion(conversation.sourceParts)
}
export async function contextVersion(parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)))
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}

export function selectedContext(conversation: Conversation, focus: string[], scope: ContextScope): AnalysisContext {
  if (scope === 'full') return { scope }
  if (scope === 'selected') return { scope, references: [...focus] }
  const wanted = new Set(focus)
  const positions = new Set<number>()
  if (!focus.length) {
    for (let i = Math.max(0, conversation.messages.length - 20); i < conversation.messages.length; i++) positions.add(i)
  }
  conversation.messages.forEach((message, index) => {
    if (!wanted.has(messageReference(message) ?? '')) return
    for (let i = Math.max(0, index - 20); i <= Math.min(conversation.messages.length - 1, index + 20); i++) positions.add(i)
  })
  const references = [...positions].sort((a, b) => a - b).map(index => messageReference(conversation.messages[index]))
  if (references.some(ref => !ref)) throw new Error('A context message has no source reference. Import the archive again.')
  return { scope, references: references as string[] }
}

async function prepareImage(file: File, reference: string): Promise<AnalysisImage> {
  if (file.size > 15 * 1024 * 1024) throw new Error('Image exceeds the 15 MiB local processing limit.')
  const bitmap = await createImageBitmap(file)
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error('Image dimensions exceed the local processing limit.')
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image preparation is unavailable in this browser.')
    context.drawImage(bitmap, 0, 0, width, height)
    return { reference, dataUrl: canvas.toDataURL('image/png'), width, height }
  } finally { bitmap.close() }
}

export async function prepareAnalysis(conversation: Conversation, assets: AssetIndex, ids: string[], question: string,
  history: (AnalysisInput & { answer: string })[], model: string, scope: ContextScope = 'surrounding'): Promise<AnalysisPayload> {
  const version = await sourceVersion(conversation)
  const selected = new Set(ids)
  const messages = conversation.messages.filter(message => selected.has(message.id))
  if (messages.length !== selected.size) throw new Error('A selected message is unavailable. Select available messages and try again.')
  if (!messages.length && !history.length) {
    if (scope === 'selected') throw new Error('Select messages or choose a different context to start a discussion.')
    if (!conversation.messages.length) throw new Error('This conversation has no messages to use as context.')
  }
  const turn: AnalysisInput = { question: question.trim(), focus: [], context: { scope: 'full' }, images: [], excluded: [] }
  for (const message of messages) {
    const reference = messageReference(message)
    if (!reference) throw new Error('A selected message has no source reference. Import the archive again.')
    turn.focus.push(reference)
    for (const attachment of message.attachments) {
      const exclude = (reason: string) => turn.excluded.push({ reference, reason })
      if (attachment.remote) { exclude('Remote media is excluded. No linked resource is fetched for analysis.'); continue }
      const file = assets.resolve(attachment.uri, message.sourceDirectory)
      if (!file) { exclude('Attachment is unavailable in this archive.'); continue }
      try {
        const type = await identifyMedia(file, attachment.kind)
        if (type !== 'image') { exclude(`${type === 'file' ? 'This file type is' : `${type === 'audio' ? 'Audio' : 'Video'} is`} not supported for analysis.`); continue }
        const signature = new TextDecoder().decode(await file.slice(0, 6).arrayBuffer())
        if (attachment.animated || signature.startsWith('GIF8')) { exclude('Animated image analysis is not supported in this release.'); continue }
        if (turn.images.length + history.reduce((sum, item) => sum + item.images.length, 0) >= 8) throw new Error('image_limit')
        turn.images.push(await prepareImage(file, reference))
      } catch (error) {
        if (error instanceof Error && error.message === 'image_limit') throw new Error('This discussion exceeds the eight-image limit. Nothing was sent. Start a new discussion or select fewer images.')
        exclude('Image could not be prepared within supported format, size, or dimension limits.')
      }
    }
  }
  turn.context = !messages.length && history.length ? { scope: 'discussion' } : selectedContext(conversation, turn.focus, scope)
  const sourceParts = scopedSourceParts(conversation.sourceParts!, [...history.map(turn => turn.context), turn.context])
  const payload = { requestId: crypto.randomUUID(), model, sourceVersion: version, contextVersion: await contextVersion(sourceParts), sourceParts, history, turn }
  try { return validateAnalysis(payload) }
  catch (error) {
    if (error instanceof Error && error.message === 'context_too_large') throw new Error('This request exceeds Echo’s 24 MB transfer limit. Nothing was sent. Choose a narrower context, fewer images, or a new discussion to leave earlier context behind.')
    throw new Error('The selected context could not be prepared. Check your question and selection.')
  }
}
