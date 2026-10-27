import { createHash } from 'node:crypto'
import { validateAssetChoices, validatePromptAssets } from '../../shared/prompt-assets.mjs'

export function resolvePromptAssets(choices, activeId, conversation, contextBuilder) {
  let validated
  try { validated = validateAssetChoices(choices, activeId) } catch { throw new Error('library_invalid_input') }
  const assets = validated.map(choice => {
    const item = conversation(choice.conversationId)
    const context = contextBuilder.build({ userId: item.userId, conversationId: item.id }, [], {
      question: 'Attached conversation context', focus: [], scope: choice.scope, model: 'local-context',
    })
    return { ...choice, title: item.title, sourceVersion: context.sourceVersion, sourceParts: context.sourceParts,
      contextVersion: createHash('sha256').update(JSON.stringify(context.sourceParts)).digest('hex'), referenceMap: context.referenceMap }
  })
  try { return validatePromptAssets(assets) } catch { throw new Error('library_invalid_input') }
}
