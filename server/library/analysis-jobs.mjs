import { createHash } from 'node:crypto'
import { validateAnalysis } from '../../shared/analysis-policy.mjs'
import { prepareContext } from './prepare-context.mjs'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function createAnalysisJobs({ library, provider }) {
  const active = new Map(), subjects = new Map(), preparedTurns = new Map()
  let preparing = false, paused = false
  function prune() { for (const [id,value] of preparedTurns) if (value.expires <= Date.now()) preparedTurns.delete(id) }
  const timer = setInterval(prune, 30_000); timer.unref()
  let accepting = false, closed = false
  async function discussionDraft(discussionId) {
    const { title, draft, draftRevision } = await library.discussion({ discussionId })
    return { title, draft, draftRevision }
  }
  async function run(turn, prepared) {
    const controller = new AbortController()
    let answer = '', lastSaved = 0, complete = false, storageFailed = false
    const operation = Promise.resolve().then(async () => {
      try {
        await prepared.run({ signal: controller.signal, onEvent: async event => {
          if (event.type === 'delta') answer += event.delta
          if (event.type === 'complete') complete = true
          if (answer.length > 500_000) throw new Error('provider_failure')
          if (complete || Date.now() - lastSaved >= 250) {
            try { await library.updateTurn({ turnId: turn.id, answer, status: complete ? 'complete' : 'sending' }); lastSaved = Date.now() }
            catch { storageFailed = true; controller.abort(); throw new Error('storage_failed') }
          }
        } })
        if (!complete) throw new Error('provider_failure')
      } catch (error) {
        const code = storageFailed ? 'storage_failed' : controller.signal.aborted ? 'canceled' : ['expired','quota','provider_context'].includes(error.message) ? error.message : 'provider_failed'
        // If persistence fails, leave the durable sending state intact. Startup
        // turns that state into outcome_unknown; never claim a saved completion.
        try { await library.updateTurn({ turnId: turn.id, answer, status: code === 'canceled' ? 'canceled' : 'failed', error: code }) } catch { /* Recover on restart. */ }
      } finally { active.delete(turn.id) }
    })
    active.set(turn.id, { controller, operation })
    return operation
  }
  return {
    async generateSubject(req, discussionId, model, signal) {
      if (closed || paused || subjects.size || active.size || preparing || accepting) throw new Error('library_busy')
      const controller = new AbortController()
      const operation = (async () => {
        try {
          const input = await library.discussionSubjectInput({ discussionId })
          if (!input) return { updated: false }
          if (!provider.generateSubject) throw new Error('library_provider_unavailable')
          const title = await provider.generateSubject(req, { model, question: input.question },
            { signal: AbortSignal.any([signal, controller.signal]) })
          if (closed || paused || signal.aborted || controller.signal.aborted) throw new Error('library_busy')
          return await library.saveDiscussionSubject({ discussionId, title, expectedTitle: input.title, draftRevision: input.draftRevision })
        } catch (error) {
          if (['unauthorized','expired'].includes(error.message)) throw new Error('library_subject_connection_required')
          if (error.message === 'quota') throw new Error('library_subject_quota')
          if (['model_unavailable','connection_failed'].includes(error.message)) throw new Error('library_subject_failed')
          throw error
        } finally { subjects.delete(discussionId) }
      })()
      subjects.set(discussionId, { controller, operation })
      return operation
    },
    async prepare(req, input) {
      if (closed || paused || preparing) throw new Error('library_busy')
      preparing = true
      try {
        prune()
        if (preparedTurns.size >= 4) preparedTurns.delete(preparedTurns.keys().next().value)
        const result = await prepareContext(library, input)
        if (!provider.prepareJob) throw new Error('library_provider_unavailable')
        const prepared = await provider.prepareJob(req, result.payload)
        if (closed || paused) throw new Error('library_busy')
        preparedTurns.set(result.payload.requestId, { discussionId: input.discussionId, prepared, digest: digest(result.payload), expires: Date.now() + 300_000 })
        return { version: 1, ...result }
      } finally { preparing = false }
    },
    async accept(req, { discussionId, payload }) {
      if (closed || paused || accepting) throw new Error('library_busy')
      accepting = true
      try {
        // Existing durable IDs are looked up before touching the provider. The
        // accepted snapshot is immutable and is never automatically redispatched.
        try {
          const prior = await library.analysisTurn({ turnId: payload?.requestId })
          if (prior.discussionId !== discussionId || prior.requestDigest !== digest(validateAnalysis(payload))) throw new Error('library_invalid_input')
          return { version: 1, accepted: false, turn: prior, discussion: await discussionDraft(discussionId) }
        } catch (error) { if (error.message !== 'library_not_found') throw error }
        if (active.size >= 1) throw new Error('library_busy')
        prune()
        const pending = preparedTurns.get(payload?.requestId)
        if (!pending || pending.discussionId !== discussionId || pending.digest !== digest(payload)) throw new Error('library_context_changed')
        const prepared = pending.prepared
        if (provider.currentAccount && await provider.currentAccount(req) !== prepared.providerAccount) throw new Error('library_context_changed')
        if (closed || paused) throw new Error('library_busy')
        const turn = await library.acceptTurn({ discussionId, payload, providerAccount: prepared.providerAccount })
        preparedTurns.delete(payload.requestId)
        if (turn.accepted) void run(turn, prepared)
        return { version: 1, accepted: turn.accepted, turn, discussion: await discussionDraft(discussionId) }
      } finally { accepting = false }
    },
    async cancel(turnId) {
      const turn = await library.analysisTurn({ turnId })
      const running = active.get(turnId)
      if (running) { running.controller.abort(); await running.operation }
      return { version: 1, turn: await library.analysisTurn({ turnId: turn.id }) }
    },
    async deleteDiscussion(discussionId) {
      const discussion = await library.discussion({ discussionId })
      for (const turn of discussion.turns) if (turn.status === 'sending') await this.cancel(turn.id)
      return library.deleteDiscussion({ discussionId })
    },
    async pause() {
      paused = true; preparedTurns.clear()
      for (const entry of subjects.values()) entry.controller.abort()
      while (accepting || preparing) await new Promise(resolve => setTimeout(resolve, 20))
      for (const entry of active.values()) entry.controller.abort()
      await Promise.all([...active.values()].map(entry => entry.operation))
      await Promise.allSettled([...subjects.values()].map(entry => entry.operation))
    },
    resume() { paused = false },
    async close() {
      closed = true; clearInterval(timer); preparedTurns.clear()
      for (const entry of subjects.values()) entry.controller.abort()
      while (accepting || preparing) await new Promise(resolve => setTimeout(resolve, 20))
      for (const entry of active.values()) entry.controller.abort()
      await Promise.all([...active.values()].map(entry => entry.operation))
      await Promise.allSettled([...subjects.values()].map(entry => entry.operation))
    },
  }
}
