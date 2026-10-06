import type { AnalysisState, AnalysisThread, AnalysisTurn } from '../stores/analysis'
import type { Conversation } from './archive'
import { sourceVersion, contextVersion } from './analysis-context'
import { contextScopes, validateAnalysis, type ContextScope } from '../../shared/analysis-policy.mjs'
import { scopedSourceParts } from '../../shared/analysis-source.mjs'

export async function exportDiscussions(state: AnalysisState, conversation: Conversation) {
  const version = await sourceVersion(conversation)
  return JSON.stringify({ version: 4, sourceVersion: version, threads: state.threads.map(thread => ({
    title: thread.title, draft: thread.draft, scope: thread.scope, turns: thread.turns.map(turn => ({
      question: turn.question, focus: turn.focus, context: turn.context, images: turn.images, excluded: turn.excluded,
      answer: turn.answer, status: turn.status === 'sending' ? 'canceled' : turn.status,
    })),
  })) })
}

export async function importDiscussions(text: string, conversation: Conversation): Promise<AnalysisThread[]> {
  if (text.length > 24_000_000) throw new Error('The discussion file is too large.')
  const source = await sourceVersion(conversation)
  let value
  try { value = JSON.parse(text) } catch { throw new Error('Choose a valid Echo discussion file.') }
  if (![1, 2, 3, 4].includes(value?.version) || !Array.isArray(value.threads) || !value.threads.length || value.threads.length > 50) throw new Error('This discussion file format is unsupported.')
  if (value.sourceVersion !== source) throw new Error('This file belongs to a different conversation or source version. Open the matching archive before loading it.')
  try {
    return await Promise.all(value.threads.map(async (thread: Record<string, unknown>) => {
      if (typeof thread.title !== 'string' || thread.title.length > 160 || typeof thread.draft !== 'string' || thread.draft.length > 16_000 || !Array.isArray(thread.turns) || thread.turns.length > 100) throw new Error()
      const scope = value.version === 1 ? 'full' : thread.scope
      if (!contextScopes.includes(scope as ContextScope)) throw new Error()
      const turns: AnalysisTurn[] = []
      for (const turn of thread.turns) {
        if (!turn || typeof turn.answer !== 'string' || turn.answer.length > 500_000 || !['complete', 'failed', 'canceled'].includes(turn.status)) throw new Error()
        const restoredTurn = { ...turn, context: value.version === 1 ? { scope: 'full' } : turn.context }
        const history = turns.filter(turn => turn.status === 'complete')
        const sourceParts = scopedSourceParts(conversation.sourceParts!, [...history.map(turn => turn.context), restoredTurn.context])
        const validated = validateAnalysis({ requestId: crypto.randomUUID(), model: 'gpt-6.1-sol', sourceVersion: source,
          contextVersion: await contextVersion(sourceParts), sourceParts, history, turn: restoredTurn })
        turns.push({ ...validated.turn, id: crypto.randomUUID(), answer: turn.answer, status: turn.status })
      }
      return { id: crypto.randomUUID(), title: thread.title, draft: thread.draft, scope: scope as ContextScope, sourceVersion: source, turns }

    }))
  } catch { throw new Error('The saved discussions contain unavailable messages or unsupported content.') }
}
