import { createHash } from 'node:crypto'
import { sourceFieldEntries } from '../../shared/analysis-source.mjs'

export function messageContentKey(source) {
  const fields = sourceFieldEntries(source).filter(([key]) => key !== 'reactions').sort(([left], [right]) => left.localeCompare(right))
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

export function currentMessageVersions(observations) {
  const byMessage = new Map()
  for (const observation of observations) {
    if (!byMessage.has(observation.messageId)) byMessage.set(observation.messageId, new Map())
    const groups = byMessage.get(observation.messageId), key = messageContentKey(observation.source), previous = groups.get(key)
    if (!previous) groups.set(key, observation)
    else if (observation.importedOrder > previous.importedOrder || observation.importedOrder === previous.importedOrder && observation.cursor > (previous.observedCursor ?? previous.cursor)) {
      groups.set(key, { ...observation, cursor: previous.cursor, observedCursor: observation.cursor })
    }
  }
  const versions = [], messages = new Map()
  for (const [id, groups] of byMessage) {
    const values = [...groups.values()]
    messages.set(id, values); versions.push(...values)
  }
  return { versions, byMessage: messages }
}

export function createMessageVersionStore({ db, revision }) {
  let cached
  function read(userId, conversationId, messageIds) {
    const current = revision()
    if (cached?.revision === current && cached.userId === userId && cached.conversationId === conversationId) return cached
    if (messageIds?.length === 0) return { observations: [], versions: [], byMessage: new Map() }
    const filter = messageIds ? ` AND v.message_id IN (${messageIds.map(() => '?').join(',')})` : ''
    const observations = db.prepare(`WITH latest_parts AS MATERIALIZED (
      SELECT x.part_id,MAX(i.rowid) AS import_order FROM import_source_parts x
      JOIN imports i ON i.user_id=x.user_id AND i.id=x.import_id
      WHERE i.user_id=? AND i.conversation_id=? GROUP BY x.part_id
    ) SELECT v.id,v.message_id AS messageId,v.source_json AS source,v.rowid AS cursor,
      COALESCE((SELECT MAX(COALESCE(l.import_order,i.rowid)) FROM source_occurrences o
        JOIN source_parts p ON p.user_id=o.user_id AND p.id=o.part_id
        JOIN imports i ON i.user_id=p.user_id AND i.id=p.import_id
        LEFT JOIN latest_parts l ON l.part_id=o.part_id
        WHERE o.user_id=v.user_id AND o.message_id=v.message_id AND o.version_id=v.id),0) AS importedOrder
      FROM message_versions v JOIN messages m ON m.user_id=v.user_id AND m.id=v.message_id
      WHERE v.user_id=? AND v.conversation_id=?${filter} ORDER BY m.ordinal,v.rowid`).all(userId, conversationId, userId, conversationId, ...(messageIds ?? []))
    const result = { revision: current, userId, conversationId, observations, ...currentMessageVersions(observations) }
    if (!messageIds) cached = result
    return result
  }
  return { read, clear() { cached = undefined } }
}
