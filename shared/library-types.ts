import type { AnalysisInput } from './analysis-policy.mjs'
export interface LibraryOwner { userId: string; label: string }
export interface LibraryContextNote { userId: string; conversationId: string; markdown: string; revision: number }
export interface LibraryConversationContext extends LibraryContextNote {
  relatedConversationIds: string[];
  inheritance: 'none' | 'resolved' | 'unresolved';
  inherited: { conversationId: string; title: string; participant: string }[];
}
export interface LibraryStatus { version: 1; cleanupRequired?: boolean; schemaVersion: number; revision: number; owner: LibraryOwner | null }
export interface LibraryConversation { id: string; userId: string; title: string; participants: string[]; category: 'Inbox' | 'Requests'; pictures: { name: string; assetId: string }[]; messageCount: number; preview: { text: string; timestamp: number | null } | null }
export interface LibraryAttachment { id: string; userId: string; assetId: string | null; slot: number; kind: 'image' | 'audio' | 'video' | 'file' }
export interface LibraryMessage {
  id: string; userId: string; conversationId: string; ordinal: number; sender: string; text: string; timestamp: number | null;
  sourceJson: string; sourceAssets: { uri: string; assetId: string }[]; assetConflictCount: number; versionCount: number; versionId: string; partId: string; sourceIndex: number; attachments: LibraryAttachment[]
}
export interface LibraryPosition { userId: string; conversationId: string; messageId: string; offset: number }
export interface LibraryAsset { id: string; userId: string; size: number }
export interface LibrarySource { id: string; userId: string; conversationId: string; sourceJson: string }
export interface ImportSummary { userId: string; revision: number; additions: number; matched: number; changed: number; unavailableAssets: number; conversations: number; unresolved: number }
export interface ImportChoices { ownerChoice?: { label: string; sameOwner?: boolean }; conversations?: Record<string, string>; messages?: Record<string, Record<string, string>> }
export interface ImportReview {
  version: 1; ready: boolean;
  owner: { label: string; needsReview: boolean; candidates: string[]; existing: LibraryOwner | null };
  conversations: { key: string; title: string; count: number; target: string | null; suggested?: string | null;
    identity?: { handle: string; sourceId: string } | null;
    candidates: { id: string; title: string; confident: boolean; match?: 'both' | 'id' | 'handle'; identity?: { handle: string; sourceId: string } }[];
    messages: { index: number; candidates: string[]; evidence: { id: string; sender: string; timestamp: number | null; text: string; before: string; after: string }[]; sender: string; text: string; timestamp: number | null }[] }[];
}
export interface ImportJob {
  version: 1; id: string; userId?: string; kind: 'zip' | 'folder';
  state: 'transferring' | 'extracting' | 'validating' | 'review' | 'committing' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  bytes: number; files: number; cleanupRequired: boolean; error?: string;
  progress?: { phase: string; completed: number; total: number; bytes?: number;
    current?: { unit: 'messages' | 'candidates'; completed: number; total: number } };
  review?: ImportReview; summary?: ImportSummary;
}

export interface LibrarySnapshot { sourceVersion: string; userId: string; conversationId: string; revision: number; sourceParts: string[]; references: Record<string, number>; referenceMap: Record<string, string> }

export interface LibraryDiscussion {
  id: string; userId: string; conversationId: string; title: string; draft: string;
  scope: import('./analysis-policy.mjs').ContextScope; draftRevision: number; sourceVersion: string | null;
  assets?: import('./prompt-assets.mjs').ConversationAssetChoice[];
}
export interface LibraryTurn extends AnalysisInput {
  id: string; userId: string; sequence: number; referenceMap: Record<string, string>; answer: string;
  status: 'sending' | 'complete' | 'failed' | 'canceled' | 'interrupted'; error?: string;
}
export interface LibraryDiscussionDetail extends LibraryDiscussion {
  turns: LibraryTurn[]; contextSource?: { sourceVersion: string; sourceParts: string[] };
}
export interface LibraryContextStatus {
  status: 'initial' | 'existing' | 'update' | 'outside-scope';
  scope: import('./analysis-policy.mjs').ContextScope; generation: string;
}
