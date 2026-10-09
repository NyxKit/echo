import { createHash } from 'node:crypto'
import { compactJson } from '../../shared/analysis-source.mjs'
export const MATCHER_VERSION = 'ordered-observations-v2'
export const fingerprint = source => createHash('sha256').update(compactJson(source)).digest('hex')
const equalSequence = (left, right) => left.length === right.length && left.every((item, index) => item.fingerprint === right[index].fingerprint)
function positions(records) {
  const map = new Map()
  records.forEach((record, index) => { const key = record.fingerprint; if (!map.has(key)) map.set(key, []); map.get(key).push(index) })
  return map
}
export function orderedAnchors(previous, incoming) {
  const old = positions(previous), fresh = positions(incoming), anchors = []
  for (const [key, indexes] of fresh) if (indexes.length === 1 && old.get(key)?.length === 1) anchors.push([indexes[0], old.get(key)[0]])
  anchors.sort((a, b) => a[0] - b[0])
  const ordered = anchors.every((anchor, index) => !index || anchor[1] > anchors[index - 1][1])
  return { anchors: ordered ? anchors : [], confident: ordered && anchors.length >= 3,
    identical: incoming.length > 0 && equalSequence(previous, incoming) }
}

// Identities are assigned one-to-one. Repeated fingerprints remain occurrences.
export function reconcileRecords(previous, incoming) {
  const matches = new Map(), used = new Set(), ambiguous = []
  if (equalSequence(previous, incoming)) {
    incoming.forEach((_record, index) => matches.set(index, previous[index].id))
    return { matches, ambiguous }
  }
  const { anchors } = orderedAnchors(previous, incoming)
  const bind = (fresh, old) => { matches.set(fresh, previous[old].id); used.add(old) }
  for (const [fresh, old] of anchors) bind(fresh, old)
  const boundaries = [[-1, -1], ...anchors, [incoming.length, previous.length]]
  for (let i = 1; i < boundaries.length; i++) {
    const [a, b] = boundaries[i - 1], [c, d] = boundaries[i]
    const next = incoming.slice(a + 1, c), prior = previous.slice(b + 1, d)
    if (equalSequence(prior, next) && a >= 0 && c < incoming.length) {
      next.forEach((_record, offset) => bind(a + 1 + offset, b + 1 + offset))
    } else if (a >= 0 && c < incoming.length && next.length === 1 && prior.length === 1 &&
        next[0].sender === prior[0].sender && next[0].timestamp !== null && next[0].timestamp === prior[0].timestamp) {
      bind(a + 1, b + 1)
    }
  }
  const byFingerprint = new Map(), byIdentity = new Map()
  previous.forEach((record, index) => {
    for (const [map, key] of [[byFingerprint, record.fingerprint], [byIdentity, JSON.stringify([record.sender, record.timestamp])]]) {
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(index)
    }
  })
  let edges = 0
  for (let index = 0; index < incoming.length; index++) {
    if (matches.has(index)) continue
    const record = incoming[index]
    const possible = new Set([...(byFingerprint.get(record.fingerprint) ?? []), ...(record.timestamp !== null ? byIdentity.get(JSON.stringify([record.sender, record.timestamp])) ?? [] : [])])
    if (possible.size > 1000) throw new Error('import_limit')
    const candidates = [...possible].filter(oldIndex => !used.has(oldIndex)).map(oldIndex => previous[oldIndex].id)
    edges += candidates.length
    if (edges > 10_000 || ambiguous.length >= 1000) throw new Error('import_limit')
    if (candidates.length) ambiguous.push({ index, candidates })
  }
  return { matches, ambiguous }
}
