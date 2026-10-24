import type { TimeScope } from './context-windows.mjs'
export type AssetScope = TimeScope | 'full'
export interface ConversationAssetChoice { kind: 'conversation'; id: string; conversationId: string; scope: AssetScope }
export interface ConversationPromptAsset extends ConversationAssetChoice {
  title: string; sourceVersion: string; contextVersion: string; sourceParts: string[]; referenceMap: Record<string, string>
}
export const conversationAssetLimit: number
export const assetScopes: AssetScope[]
export function validateAssetChoices(value: unknown, activeConversationId?: string): ConversationAssetChoice[]
export function validatePromptAssets(value: unknown): ConversationPromptAsset[]
export function assetCitation(assetId: string, reference: string): string
