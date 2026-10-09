import type { AnalysisPayload } from '../../shared/analysis-policy.mjs'
import type { LibraryDiscussion, LibraryDiscussionDetail, LibraryTurn, LibrarySnapshot, ImportChoices, ImportJob, ImportReview, ImportSummary, LibraryStatus, LibraryConversation, LibraryAttachment, LibraryMessage, LibraryPosition, LibraryAsset } from '../../shared/library-types'
export type { LibraryOwner, LibraryStatus, LibraryConversation, LibraryAttachment, LibraryMessage, LibraryPosition, LibraryAsset } from '../../shared/library-types'
export interface Library {
  imports: {
    list(): ImportJob[]; status(id: string): ImportJob;
    create(input: { kind: 'zip' | 'folder' }): Promise<ImportJob>;
    beginFile(id: string, input: { path: string; size: number }): Promise<{ version: 1; id: string }>;
    chunk(id: string, fileId: string, offset: number, bytes: Uint8Array): Promise<{ version: 1; received: number }>;
    finishFile(id: string, fileId: string): Promise<{ version: 1; complete: true }>;
    accept(id: string): Promise<ImportJob>; review(id: string, choices: ImportChoices): Promise<ImportJob>;
    cancel(id: string): Promise<ImportJob>; retryCleanup(id: string): Promise<ImportJob>; close(): Promise<void>;
  }
  previewImport(input: { jobId: string } & ImportChoices): Promise<ImportReview>
  commitImport(input: { jobId: string } & ImportChoices): Promise<ImportSummary>
  importHistory(): Promise<(ImportSummary & { id: string })[]>
  cancelImport(): void
  resetImportCancellation(): void
  exportDiscussions(input: { conversationId: string }): Promise<{ text: string }>
  importDiscussions(input: { conversationId: string; text: string }): Promise<{ ids: string[] }>
  contextInput(input: { discussionId: string; question: string; focus?: string[]; scope: string; model: string }): Promise<unknown>
  discussions(input: { conversationId: string }): Promise<LibraryDiscussion[]>
  discussion(input: { discussionId: string }): Promise<LibraryDiscussionDetail>
  saveDiscussion(input: { id: string; conversationId: string; title: string; draft: string; scope: string; draftRevision?: number }): Promise<LibraryDiscussion>
  deleteDiscussion(input: { discussionId: string }): Promise<{ deleted: true }>
  analysisTurn(input: { turnId: string }): Promise<LibraryTurn & { discussionId: string; libraryRevision: number }>
  acceptTurn(input: { discussionId: string; payload: AnalysisPayload; providerAccount: string }): Promise<LibraryTurn & { accepted: boolean }>
  updateTurn(input: { turnId: string; answer: string; status?: string; error?: string | null }): Promise<LibraryTurn>
  deleteLibrary(): Promise<{ deleted: boolean; cleanupRequired: boolean }>
  status(): Promise<LibraryStatus>
  /** Internal capability: call only after the trusted owner-review layer resolves self. */
  resolveOwner(input: { expectedUserId?: string; evidenceJson: string; label: string }): Promise<{ userId: string; evidenceId: string; revision: number }>
  importConversation(input: {
    evidenceId: string; conversationId?: string; sourceParts: string[]; title: string; participants: string[];
    attachments?: { part: number; index: number; slot: number; kind: LibraryAttachment['kind']; assetId: string | null }[]
  }): Promise<LibraryConversation & { revision: number; changed: boolean }>
  conversations(input?: { after?: string; limit?: number }): Promise<LibraryConversation[]>
  messages(input: { conversationId: string; after?: number; limit?: number }): Promise<LibraryMessage[]>
  messageVersions(input: { messageId: string; after?: number; limit?: number }): Promise<{ id: string; userId: string; cursor: number; sourceJson: string; assets: { slot: number; assetId: string; kind: string }[] }[]>
  snapshot(input: { conversationId: string }): Promise<LibrarySnapshot>
  preferences(): Promise<{ userId: string | null; values: Record<string, string> }>
  savePreference(input: { key: string; value: string }): Promise<{ userId: string; key: string; value: string }>
  correctIdentity(input: { label: string }): Promise<{ userId: string; label: string }>
  source(input: { partId: string }): Promise<{ id: string; userId: string; conversationId: string; sourceJson: string }>
  savePosition(input: { conversationId: string; messageId: string; offset?: number }): Promise<LibraryPosition>
  position(input: { conversationId: string }): Promise<LibraryPosition | null>
  beginAsset(): Promise<{ id: string; userId: string }>
  appendAsset(input: { id: string; bytes: Uint8Array }): Promise<{ size: number }>
  finishAsset(input: { id: string }): Promise<LibraryAsset>
  cancelAsset(input: { id: string }): Promise<{ cancelled: true }>
  asset(input: { id: string }): Promise<LibraryAsset>
  readAsset(input: { id: string; offset?: number; length?: number }): Promise<{ id: string; userId: string; bytes: Uint8Array }>
  close(): Promise<void>
}
export function libraryDirectory(env?: NodeJS.ProcessEnv): string
export function openLibrary(directory: string): Promise<Library>
