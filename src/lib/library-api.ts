import type { AnalysisPayload } from '../../shared/analysis-policy.mjs'
import type { LibraryDiscussion, LibraryDiscussionDetail, LibraryTurn, LibrarySnapshot, ImportChoices, ImportJob, LibraryConversation, LibraryMessage, LibraryPosition, LibrarySource, LibraryStatus } from '../../shared/library-types'

const prefix = '/api/library/v1/'
export class LibraryApiError extends Error {
  constructor(public readonly code: 'session_required' | 'unavailable' | 'request_failed' | `import_${string}` | `library_${string}`) { super(code) }
}
export function isLocalLibraryRuntime(): boolean {
  return typeof document !== 'undefined' && document.querySelector('meta[name="echo-runtime"]')?.getAttribute('content') === 'local-library'
}
const id = (value: string) => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new LibraryApiError('request_failed')
  return value
}
function pageQuery(values: { after?: string | number; limit?: number }) {
  const query = new URLSearchParams()
  if (values.after !== undefined) query.set('after', String(values.after))
  if (values.limit !== undefined) query.set('limit', String(values.limit))
  return query.size ? `?${query}` : ''
}

export function createLibraryApi(request: typeof fetch = fetch) {
  async function call<T>(path: string, { method = 'GET', body, signal, bytes }: { method?: string; body?: unknown; signal?: AbortSignal; bytes?: Blob } = {}): Promise<T> {
    let response: Response
    try {
      response = await request(prefix + path, {
        method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'X-Echo-Request': '1', ...(bytes ? { 'Content-Type': 'application/octet-stream' } : body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)), signal: signal ?? AbortSignal.timeout(15_000),
      })
    } catch { throw new LibraryApiError('unavailable') }
    if (response.status === 401) throw new LibraryApiError('session_required')
    if (!response.ok) {
      let code: unknown
      try { code = (await response.json()).code } catch { /* Safe category fallback. */ }
      throw new LibraryApiError(typeof code === 'string' && /^(?:import|library)_[a-z_]{1,40}$/.test(code) ? code as `import_${string}` | `library_${string}` : response.status >= 500 ? 'unavailable' : 'request_failed')
    }
    try {
      const value = await response.json()
      if (!value || value.version !== 1) throw new Error()
      return value as T
    } catch { throw new LibraryApiError('request_failed') }
  }
  return {
    discussions: (conversationId: string) => call<{ version: 1; items: LibraryDiscussion[] }>(`conversations/${id(conversationId)}/discussions`),
    discussion: (discussionId: string) => call<LibraryDiscussionDetail & { version: 1 }>(`discussions/${id(discussionId)}`),
    saveDiscussion: (discussionId: string, value: { conversationId: string; title: string; draft: string; scope: string; draftRevision: number }) => call<LibraryDiscussion & { version: 1 }>(`discussions/${id(discussionId)}`, { method: 'PUT', body: value }),
    deleteDiscussion: (discussionId: string) => call<{ version: 1; deleted: true }>(`discussions/${id(discussionId)}/delete`, { method: 'POST' }),
    prepareTurn: (discussionId: string, input: { question: string; focus: string[]; scope: string; model: string }) => call<{ version: 1; payload: AnalysisPayload; referenceMap: Record<string, string>; revision: number }>(`discussions/${id(discussionId)}/prepare`, { method: 'POST', body: input, signal: AbortSignal.timeout(90_000) }),
    acceptTurn: (discussionId: string, payload: AnalysisPayload) => call<{ version: 1; accepted: boolean; turn: LibraryTurn }>(`discussions/${id(discussionId)}/turns`, { method: 'POST', body: { payload }, signal: AbortSignal.timeout(90_000) }),
    turn: (turnId: string) => call<{ version: 1; turn: LibraryTurn }>(`turns/${id(turnId)}`),
    cancelTurn: (turnId: string) => call<{ version: 1; turn: LibraryTurn }>(`turns/${id(turnId)}/cancel`, { method: 'POST' }),
    imports: (signal?: AbortSignal) => call<{ version: 1; jobs: ImportJob[] }>('imports', { signal }),
    importStatus: (jobId: string, signal?: AbortSignal) => call<ImportJob>(`imports/${id(jobId)}`, { signal }),
    createImport: (kind: 'zip' | 'folder') => call<ImportJob>('imports', { method: 'POST', body: { kind } }),
    beginImportFile: (jobId: string, path: string, size: number) => call<{ version: 1; id: string }>(`imports/${id(jobId)}/files`, { method: 'POST', body: { path, size } }),
    uploadImportChunk: (jobId: string, fileId: string, offset: number, bytes: Blob, signal?: AbortSignal) => call<{ version: 1; received: number }>(`imports/${id(jobId)}/files/${id(fileId)}?offset=${offset}`, { method: 'PUT', bytes, signal }),
    finishImportFile: (jobId: string, fileId: string) => call<{ version: 1; complete: true }>(`imports/${id(jobId)}/files/${id(fileId)}/complete`, { method: 'POST' }),
    acceptImport: (jobId: string) => call<ImportJob>(`imports/${id(jobId)}/accept`, { method: 'POST' }),
    reviewImport: (jobId: string, choices: ImportChoices) => call<ImportJob>(`imports/${id(jobId)}/review`, { method: 'POST', body: choices }),
    cancelImport: (jobId: string) => call<ImportJob>(`imports/${id(jobId)}/cancel`, { method: 'POST' }),
    cleanupImport: (jobId: string) => call<ImportJob>(`imports/${id(jobId)}/cleanup`, { method: 'POST' }),
    deleteLibrary: () => call<{ version: 1; deleted: boolean; cleanupRequired: boolean }>('delete', { method: 'POST', signal: AbortSignal.timeout(90_000) }),
    status: (signal?: AbortSignal) => call<LibraryStatus>('status', { signal }),
    conversations: (page: { after?: string; limit?: number } = {}, signal?: AbortSignal) => call<{ version: 1; items: LibraryConversation[] }>('conversations' + pageQuery(page), { signal }),
    messages: (conversationId: string, page: { after?: number; limit?: number } = {}, signal?: AbortSignal) => call<{ version: 1; items: LibraryMessage[] }>(`conversations/${id(conversationId)}/messages${pageQuery(page)}`, { signal }),
    messageVersions: (messageId: string, after = 0) => call<{ version: 1; items: { id: string; userId: string; cursor: number; sourceJson: string; assets: { slot: number; assetId: string; kind: string }[] }[] }>(`messages/${id(messageId)}/versions?after=${after}&limit=20`),
    snapshot: (conversationId: string, signal?: AbortSignal) => call<LibrarySnapshot & { version: 1 }>(`conversations/${id(conversationId)}/snapshot`, { signal }),
    preferences: () => call<{ version: 1; userId: string | null; values: Record<string, string> }>('preferences'),
    savePreference: (key: string, value: string) => call<{ version: 1; userId: string; key: string; value: string }>('preferences', { method: 'POST', body: { key, value } }),
    correctIdentity: (label: string) => call<{ version: 1; userId: string; label: string }>('identity', { method: 'POST', body: { label } }),
    source: (partId: string, signal?: AbortSignal) => call<LibrarySource & { version: 1 }>(`sources/${id(partId)}`, { signal }),
    position: (conversationId: string, signal?: AbortSignal) => call<{ version: 1; position: LibraryPosition | null }>(`conversations/${id(conversationId)}/position`, { signal }),
    savePosition: (conversationId: string, position: { messageId: string; offset?: number }) => call<{ version: 1; position: LibraryPosition }>(`conversations/${id(conversationId)}/position`, { method: 'POST', body: position }),
    assetUrl: (assetId: string) => prefix + `assets/${id(assetId)}`,
    disconnect: () => call<{ version: 1; status: 'disconnected' }>('session/disconnect', { method: 'POST' }),
    quit: () => call<{ version: 1; status: 'stopping' }>('quit', { method: 'POST' }),
  }
}
