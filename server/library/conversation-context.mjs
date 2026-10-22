import { createHash } from 'node:crypto'
import { participantIdentity } from './participant-identity.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = code => { throw new Error(code) }
export function createConversationContext({ db, owner, conversation, transaction }) {
  const all = (sql, ...args) => db.prepare(sql).all(...args)
  function note(userId, conversationId) {
    return db.prepare('SELECT markdown,revision FROM conversation_context WHERE user_id=? AND conversation_id=?').get(userId, conversationId) ?? { markdown: '', revision: 0 }
  }
  function resolve(conversationId) {
    const item = conversation(conversationId), userId = owner().userId
    const ownerIds = all('SELECT stable_id FROM owner_identities WHERE user_id=?', userId).map(row => row.stable_id)
    // Only participant account claims from the latest committed observation.
    // No individual messages, media or discussions are read by inheritance.
    const rows = all(`SELECT c.id,c.title,c.participants_json,json_extract(p.source_json,'$.participants') AS participants,
      EXISTS(SELECT 1 FROM source_parts h WHERE h.user_id=c.user_id AND h.conversation_id=c.id
        AND json_array_length(h.source_json,'$.participants')>2) AS known_group
      FROM conversations c LEFT JOIN imports i ON i.user_id=c.user_id AND i.conversation_id=c.id
        AND i.revision=(SELECT MAX(z.revision) FROM imports z WHERE z.user_id=c.user_id AND z.conversation_id=c.id)
      LEFT JOIN import_source_parts x ON x.user_id=i.user_id AND x.import_id=i.id
      LEFT JOIN source_parts p ON p.user_id=x.user_id AND p.id=x.part_id
      WHERE c.user_id=? ORDER BY c.id,x.ordinal`, userId)
    const identities = new Map()
    for (const row of rows) {
      if (!identities.has(row.id)) identities.set(row.id, { id: row.id, title: row.title, knownGroup: Boolean(row.known_group), labels: JSON.parse(row.participants_json), observations: [] })
      identities.get(row.id).observations.push(row.participants ? JSON.parse(row.participants) : null)
    }
    for (const value of identities.values()) value.identity = participantIdentity(value.observations, ownerIds)
    const active = identities.get(conversationId), identity = active.identity
    const group = active.knownGroup || identity.kind === 'group' || active.labels.length > 2
    const own = note(userId, conversationId), notes = [], inherited = [], candidates = []
    if (own.markdown.trim()) notes.push({ userId, conversationId, revision: own.revision, kind: group ? 'group' : 'conversation', label: item.title, markdown: own.markdown })
    if (group && !identity.unresolved) {
      for (const candidate of identities.values()) {
        if (candidate.id === conversationId || candidate.knownGroup || candidate.labels.length > 2 || candidate.identity.kind !== 'direct' || candidate.identity.unresolved) continue
        const person = identity.people.find(person => person.id === candidate.identity.people[0].id)
        if (!person) continue
        const saved = note(userId, candidate.id)
        candidates.push([candidate.id, candidate.identity, saved.revision])
        if (!saved.markdown.trim()) continue
        notes.push({ userId, conversationId: candidate.id, revision: saved.revision, kind: 'participant', participantId: person.id, label: person.label, markdown: saved.markdown })
        inherited.push({ conversationId: candidate.id, title: candidate.title, participant: person.label })
      }
    }
    const binding = hash([userId, conversationId, own.revision, group, identity, candidates])
    return { userId, conversationId, ...own, inherited, relatedConversationIds: candidates.map(value => value[0]), inheritance: !group ? 'none' : identity.unresolved ? 'unresolved' : 'resolved',
      background: { version: 1, binding, notes } }
  }
  return {
    conversationContext({ conversationId }) { const { background: _background, ...value } = resolve(conversationId); return value },
    resolveConversationContext: resolve,
    saveConversationContext({ conversationId, markdown, revision }) {
      const { userId } = conversation(conversationId)
      if (typeof markdown !== 'string' || Buffer.byteLength(markdown) > 262_144 || !Number.isSafeInteger(revision) || revision < 0) fail('library_invalid_input')
      transaction(() => {
        const previous = note(userId, conversationId)
        if (revision !== previous.revision) fail('library_note_conflict')
        db.prepare(`INSERT INTO conversation_context VALUES (?,?,?,?) ON CONFLICT(user_id,conversation_id)
          DO UPDATE SET markdown=excluded.markdown,revision=excluded.revision`).run(userId, conversationId, markdown, revision + 1)
      })
      return { userId, conversationId, markdown, revision: revision + 1 }
    },
  }
}
