import { validateAssetChoices, type ConversationAssetChoice, type ConversationPromptAsset } from '../../shared/prompt-assets.mjs'
import { scopedSourceParts } from '../../shared/analysis-source.mjs'
import { conversationRoutes } from './conversation-routes'
import type { Conversation } from './archive'
import { contextVersion, messageReference, selectedContext, sourceVersion } from './analysis-context'

export async function preparePromptAssets(conversations: Conversation[], choices: ConversationAssetChoice[], activeId: string): Promise<ConversationPromptAsset[]> {
  const result: ConversationPromptAsset[] = []
  for (const choice of validateAssetChoices(choices, activeId)) {
    const conversation = conversations.find(value => value.id === choice.conversationId)
    if (!conversation) throw new Error('An attached conversation is unavailable. Remove it or reopen the archive.')
    const version = await sourceVersion(conversation)
    const context = selectedContext(conversation, [], choice.scope)
    const sourceParts = scopedSourceParts(conversation.sourceParts!, [context])
    const included = context.scope === 'full' ? undefined : new Set('references' in context ? context.references : [])
    const referenceMap = Object.fromEntries(conversation.messages.flatMap(message => {
      const reference = messageReference(message)
      return reference && (!included || included.has(reference)) ? [[reference, message.id]] : []
    }))
    const opaqueId = (await conversationRoutes([conversation])).get(conversation.id)!
    result.push({ ...choice, conversationId: opaqueId, title: conversation.title, sourceVersion: version,
      sourceParts, contextVersion: await contextVersion(sourceParts), referenceMap })
  }
  return result
}
