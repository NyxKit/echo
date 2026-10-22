// Supported account evidence is an explicit decimal participant user_id.
// Generic ids, thread ids, handles and display names never identify a person.
export function participantIdentity(observations, ownerIds) {
  const owners = new Set(ownerIds), accounts = new Map()
  let unresolved = false, group = false, direct = true
  let accountSet
  for (const participants of observations) {
    if (!Array.isArray(participants) || participants.length < 2) { unresolved = true; direct = false; continue }
    group ||= participants.length > 2
    direct &&= participants.length === 2
    const local = new Set()
    for (const person of participants) {
      const id = typeof person?.user_id === 'string' && /^[1-9]\d{0,29}$/.test(person.user_id) ? `instagram:${person.user_id}` : null
      if (!id || person.is_self === true && !owners.has(id)) { unresolved = true; continue }
      local.add(id)
      if (!accounts.has(id)) accounts.set(id, typeof person.name === 'string' ? person.name : 'Participant')
    }
    if (![...local].some(id => owners.has(id))) unresolved = true
    if (local.size < 2) { unresolved = true; direct = false }
    const observed = [...local].sort().join(',')
    if (accountSet !== undefined && observed !== accountSet) unresolved = true
    accountSet = observed
  }
  const people = [...accounts].filter(([id]) => !owners.has(id)).map(([id, label]) => ({ id, label })).sort((a,b) => a.id.localeCompare(b.id))
  // Differing two-person observations cannot establish a single direct partner.
  if (!observations.length || direct && people.length !== 1) unresolved = true
  return { kind: group ? 'group' : direct && !unresolved ? 'direct' : 'unknown', people, unresolved }
}
