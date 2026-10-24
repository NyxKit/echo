import { describe, expect, it } from 'vitest'
import { instagramHandleFromDirectory, instagramProfileLinks } from '../shared/instagram-profiles.mjs'

const self = { name: 'Synthetic Self' }, peer = { name: 'Synthetic Peer' }
const direct = [{ participants: [self, peer] }]

describe('Instagram profile navigation', () => {
  it('uses an unambiguous direct folder handle only for the other participant', () => {
    expect(instagramHandleFromDirectory('messages/inbox/synthetic.peer_123')).toBe('synthetic.peer')
    expect(instagramProfileLinks(direct, self.name, ['synthetic.peer'])).toEqual({ 'Synthetic Peer': 'https://www.instagram.com/synthetic.peer/' })
    expect(instagramProfileLinks(direct, '', ['synthetic.peer'])).toEqual({})
    expect(instagramProfileLinks(direct, self.name, ['old.peer', 'new.peer'])).toEqual({})
  })
  it('uses explicit usernames for participants and the owner, including in groups', () => {
    const observations = [{ owner: { ...self, username: 'synthetic.self' }, participants: [self, { ...peer, username: 'Synthetic.Peer' }, { name: 'Synthetic Third', username: 'third_example' }] }]
    expect(instagramProfileLinks(observations, self.name, ['group.title'])).toEqual({
      'Synthetic Self': 'https://www.instagram.com/synthetic.self/',
      'Synthetic Peer': 'https://www.instagram.com/synthetic.peer/',
      'Synthetic Third': 'https://www.instagram.com/third_example/',
    })
    expect(instagramProfileLinks([{ participants: [self, peer, { name: 'Synthetic Third' }] }], self.name, ['group.title'])).toEqual({})
    expect(instagramProfileLinks([{ participants: [self, peer] }, { participants: [self, { name: 'Different Peer' }] }], self.name, ['synthetic.peer'])).toEqual({})
  })
  it('prefers explicit usernames to folder labels and omits conflicting or unsafe claims', () => {
    const observed = (username: string) => ({ participants: [self, { ...peer, username }] })
    expect(instagramProfileLinks([observed('current.peer')], self.name, ['old.peer'])).toEqual({ 'Synthetic Peer': 'https://www.instagram.com/current.peer/' })
    expect(instagramProfileLinks([observed('current.peer'), observed('different.peer')], self.name, ['old.peer'])).toEqual({})
    for (const username of ['../accounts/login', 'https://foreign.invalid/', 'peer?query=1', 'peer#fragment', '<script>', '', 'a'.repeat(31)]) {
      expect(instagramProfileLinks([observed(username)], self.name, ['old.peer'])).toEqual({})
    }
    for (const directory of ['messages/inbox/123', 'messages/inbox/only_a_title', 'messages/inbox/invalid handle_123']) expect(instagramHandleFromDirectory(directory)).toBeUndefined()
    expect(instagramProfileLinks([null, { participants: [null, self] }], self.name)).toEqual({})
  })
})
