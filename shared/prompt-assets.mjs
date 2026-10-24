import { contextChoices } from './context-windows.mjs'

export const conversationAssetLimit = 10
export const assetScopes = contextChoices.filter(scope => scope !== 'selected')
const object = value => !!value && typeof value === 'object' && !Array.isArray(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fail = () => { throw new Error('invalid_prompt_assets') }

export function validateAssetChoices(value, activeConversationId) {
  if (!Array.isArray(value) || value.length > conversationAssetLimit) fail()
  const ids = new Set(), conversations = new Set()
  return value.map(asset => {
    if (!object(asset) || asset.kind !== 'conversation' || !uuid(asset.id) ||
        typeof asset.conversationId !== 'string' || !asset.conversationId || asset.conversationId.length > 4096 ||
        asset.conversationId === activeConversationId || !assetScopes.includes(asset.scope) ||
        ids.has(asset.id) || conversations.has(asset.conversationId)) fail()
    ids.add(asset.id); conversations.add(asset.conversationId)
    return { kind: 'conversation', id: asset.id, conversationId: asset.conversationId, scope: asset.scope }
  })
}

export function validatePromptAssets(value) {
  const choices = validateAssetChoices(value)
  return choices.map((choice, index) => {
    const asset = value[index]
    if (!(uuid(choice.conversationId) || hash(choice.conversationId)) || typeof asset.title !== 'string' || asset.title.length > 262_144 ||
        !hash(asset.sourceVersion) || !hash(asset.contextVersion) || !Array.isArray(asset.sourceParts) ||
        !asset.sourceParts.length || asset.sourceParts.length > 1000 || !asset.sourceParts.every(part => typeof part === 'string') ||
        !object(asset.referenceMap)) fail()
    let parts
    try { parts = asset.sourceParts.map(part => JSON.parse(part)) } catch { fail() }
    const references = []
    parts.forEach((part, p) => {
      if (!object(part) || !object(part.messages) && !Array.isArray(part.messages) ||
          choice.scope !== 'full' && (Object.keys(part).length !== 1 || !object(part.messages))) fail()
      for (const [index, record] of Object.entries(part.messages)) {
        if (!/^(0|[1-9]\d*)$/.test(index) || !Number.isSafeInteger(Number(index)) || !object(record)) fail()
        references.push(`p${p + 1}:m${Number(index) + 1}`)
      }
    })
    if (!references.length || references.length !== Object.keys(asset.referenceMap).length ||
        !references.every(ref => typeof asset.referenceMap[ref] === 'string' && asset.referenceMap[ref].length > 0 && asset.referenceMap[ref].length <= 4096)) fail()
    return { ...choice, title: asset.title, sourceVersion: asset.sourceVersion, contextVersion: asset.contextVersion,
      sourceParts: [...asset.sourceParts], referenceMap: Object.fromEntries(references.map(ref => [ref, asset.referenceMap[ref]])) }
  })
}

export function assetCitation(assetId, reference) { return `a${assetId}:${reference}` }
