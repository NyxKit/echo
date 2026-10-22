const record = value => value && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? value.replace(/[\u0080-\u00ff]+/g, part => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(part, c => c.charCodeAt(0))) }
  catch { return part }
}) : ''
const handle = value => typeof value === 'string' && /^[a-z0-9._]{1,30}$/i.test(value) && /[a-z0-9_]/i.test(value) ? value.toLowerCase() : undefined

export function instagramHandleFromDirectory(directory) {
  const match = /^(.*)_\d+$/.exec(directory.split('/').at(-1) ?? '')
  return match ? handle(match[1]) : undefined
}

// Profile navigation uses username claims, never display names as URL slugs.
// These links do not establish account identity for imports or note inheritance.
export function instagramProfileLinks(observations, selfName, handles = []) {
  const candidates = new Map(), groups = []
  function observe(name, username) {
    if (!name || username === undefined) return
    if (!candidates.has(name)) candidates.set(name, new Set())
    candidates.get(name).add(handle(username) ?? null)
  }
  for (const value of observations) {
    if (!record(value)) continue
    if (Array.isArray(value.participants)) {
      groups.push(value.participants.map(person => text(person?.name)))
      for (const person of value.participants) if (record(person)) observe(text(person.name), person.username)
    }
    for (const key of ['owner', 'account_owner']) {
      const person = value[key]
      if (record(person)) {
        const name = text(person.name) || text(person.full_name) || text(person.username)
        if (name === selfName) observe(name, person.username)
      }
    }
  }
  const names = [...new Set(groups.flat())]
  if (selfName && names.length === 2 && names.includes(selfName) && groups.every(group => group.length === 2 && group.includes(selfName))) {
    const peer = names.find(name => name !== selfName)
    const knownHandles = new Set(handles.map(handle).filter(Boolean))
    if (!candidates.has(peer) && knownHandles.size === 1) observe(peer, [...knownHandles][0])
  }
  return Object.fromEntries([...candidates].flatMap(([name, values]) => {
    const username = [...values][0]
    return values.size === 1 && username ? [[name, `https://www.instagram.com/${username}/`]] : []
  }))
}
