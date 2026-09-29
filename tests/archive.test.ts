import { describe, expect, it } from 'vitest'
import { AssetIndex, decodeText, importArchive, safeLink, safePath } from '../src/lib/archive'
import { identifyMedia } from '../src/lib/media'

function file(path: string, contents: string | Uint8Array = ''): File {
  const result = new File([contents as BlobPart], path.split('/').at(-1)!)
  Object.defineProperty(result, 'webkitRelativePath', { value: path })
  return result
}
const thread = (messages: unknown[], title = 'Synthetic conversation') => JSON.stringify({ title, participants: [{ name: 'Test sender' }], messages })

describe('local archive import', () => {
  it('combines split JSON chronologically without merging distinct conversations', async () => {
    const archive = await importArchive([
      file('sample/messages/inbox/alpha/message_2.json', thread([{ sender_name: 'Test sender', timestamp_ms: 1000, content: 'Earlier' }])),
      file('sample/messages/inbox/alpha/message_1.json', thread([{ sender_name: 'Test sender', timestamp_ms: 2000, content: 'Later' }])),
      file('sample/messages/message_requests/beta/message_1.json', thread([{ sender_name: 'Test sender', timestamp_ms: 3000, content: 'Separate' }])),
      file('sample/messages/metadata.json', JSON.stringify({ setting: true })),
    ])
    expect(archive.conversations).toHaveLength(2)
    expect(archive.conversations[0].category).toBe('Requests')
    expect(archive.conversations[1].messages.map(m => m.text)).toEqual(['Earlier', 'Later'])
    expect(archive.skipped).toBe(0)
  })

  it('isolates corrupt JSON and malformed message records', async () => {
    const archive = await importArchive([
      file('sample/broken.json', '{'),
      file('sample/chat/message.json', thread([null, 5, { sender_name: 'Test sender', content: 'Still readable', timestamp_ms: 1e30 }])),
      file('sample/unrelated.json', JSON.stringify({ messages: 'not a conversation' })),
    ])
    expect(archive.skipped).toBe(3)
    expect(archive.conversations[0].messages[0].timestamp).toBeNull()
    expect(archive.conversations[0].messages[0].text).toBe('Still readable')
  })

  it('normalizes attachments, reactions, links, and unsent messages', async () => {
    const archive = await importArchive([file('sample/thread/messages.json', thread([
      { sender_name: 'Test sender', timestamp_ms: 1, photos: [{ uri: 'assets/image.png' }], audio_files: [{ uri: 'assets/voice.mp4' }], reactions: [{ actor: 'Other', reaction: '\u00f0\u009f\u0091\u008d' }] },
      { sender_name: 'Test sender', timestamp_ms: 2, share: { link: 'javascript:alert(1)' } },
      { sender_name: 'Test sender', timestamp_ms: 3, is_unsent: true },
    ]))])
    const messages = archive.conversations[0].messages
    expect(messages[0].attachments.map(a => a.kind)).toEqual(['image', 'audio'])
    expect(messages[0].reactions[0].emoji).toBe('👍')
    expect(messages[1].link).toBeUndefined()
    expect(messages[2].text).toBe('Message unsent')
  })

  it('supports empty conversations and cancellation', async () => {
    expect((await importArchive([file('sample/empty.json', thread([]))])).conversations[0].messages).toEqual([])
    const abort = new AbortController()
    abort.abort()
    await expect(importArchive([file('sample/thread.json', thread([]))], undefined, abort.signal)).rejects.toThrow()
  })

  it('repairs escaped UTF-8 while preserving proper Unicode', () => {
    expect(decodeText('Caf\u00c3\u00a9 \u00f0\u009f\u0091\u008b')).toBe('Café 👋')
    expect(decodeText('Café, mañana, 日本語 👋')).toBe('Café, mañana, 日本語 👋')
  })
})

describe('file and link boundaries', () => {
  it.each(['../private.txt', '%2e%2e/private.txt', 'folder/../../private', '/etc/passwd', 'C:\\secret', 'https://example.test/photo', 'file:///secret', 'a/%00b'])('rejects unsafe path %s', path => {
    expect(safePath(path)).toBeUndefined()
  })

  it('resolves references with export wrappers and local paths', () => {
    const image = file('selected/messages/inbox/alpha/photos/photo.png')
    const assets = new AssetIndex([image])
    expect(assets.resolve('messages/inbox/alpha/photos/photo.png', 'selected/messages/inbox/alpha')).toBe(image)
    expect(assets.resolve('photos/photo.png', 'selected/messages/inbox/alpha')).toBe(image)
    expect(assets.resolve('old-wrapper/messages/inbox/alpha/photos/photo.png', 'selected/messages/inbox/alpha')).toBe(image)
  })

  it('never substitutes another conversation’s attachment or an ambiguous match', () => {
    const a = file('selected/messages/inbox/alpha/photos/same.png')
    const b = file('selected/messages/inbox/beta/photos/same.png')
    const assets = new AssetIndex([a, b])
    expect(assets.resolve('photos/same.png', 'selected/messages/inbox/alpha')).toBe(a)
    expect(assets.resolve('photos/same.png', 'missing')).toBeUndefined()
    expect(new AssetIndex([b]).resolve('messages/inbox/alpha/photos/same.png', 'missing')).toBeUndefined()
    expect(new AssetIndex([b]).resolve('photos/same.png', 'selected/messages/inbox/alpha')).toBeUndefined()
    expect(assets.resolve('same.png', 'missing')).toBeUndefined()
    expect(assets.resolve('../beta/photos/same.png', 'selected/messages/inbox/alpha')).toBeUndefined()
  })

  it('allows only explicit HTTP(S) links', () => {
    expect(safeLink('https://example.test')).toBe('https://example.test/')
    expect(safeLink('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(safeLink('//example.test')).toBeUndefined()
  })

  it('treats HTML or SVG disguised as an image as a download', async () => {
    expect(await identifyMedia(file('image.png', '<svg onload="alert(1)"></svg>'), 'image')).toBe('file')
    expect(await identifyMedia(file('voice.mp4', new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32])), 'audio')).toBe('audio')
  })
})

describe('identity, pictures, and GIF import', () => {
  it('identifies the unique account present in all chats from participants and senders', async () => {
    const archive = await importArchive([
      file('sample/messages/inbox/one/message.json', JSON.stringify({ title: 'One', participants: [{ name: 'Self' }, { name: 'Alex' }], messages: [] })),
      file('sample/messages/inbox/two/message.json', JSON.stringify({ title: 'Two', participants: [{ name: 'Taylor' }], messages: [{ sender_name: 'Self', content: 'Hello' }] })),
    ])
    expect(archive.selfName).toBe('Self')
  })
  it('does not guess self for one chat, multiple common participants, or inconsistent chats', async () => {
    const one = file('sample/one/message.json', thread([{ sender_name: 'Test sender', content: 'Hello' }]))
    expect((await importArchive([one])).selfName).toBe('')
    const same = { participants: [{ name: 'One' }, { name: 'Two' }], messages: [] }
    expect((await importArchive([file('sample/one/message.json', JSON.stringify(same)), file('sample/two/message.json', JSON.stringify(same))])).selfName).toBe('')
    expect((await importArchive([one, file('sample/two/message.json', JSON.stringify({ participants: [{ name: 'Other' }], messages: [] }))])).selfName).toBe('')
  })
  it('uses explicit account metadata and participant picture references without guessing filenames', async () => {
    const photo = file('sample/media/profile/self.png')
    const archive = await importArchive([
      photo,
      file('sample/personal_information/profile.json', JSON.stringify({ profile_user: [{ string_map_data: { Name: { value: 'Self' } }, media_map_data: { 'Profile Photo': { uri: 'media/profile/self.png' } } }] })),
      file('sample/messages/inbox/one/message.json', JSON.stringify({ title: 'One', participants: [{ name: 'Self' }, { name: 'Alex', profile_picture: { uri: 'photos/alex.png' } }], messages: [] })),
    ])
    expect(archive.selfName).toBe('Self')
    const picture = archive.conversations[0].pictures.Self
    expect(archive.assets.resolve(picture.uri, picture.directory)).toBe(photo)
    expect(archive.conversations[0].pictures.Alex.uri).toBe('photos/alex.png')
  })
  it('turns local GIF paths and approved GIF links into attachments while retaining surrounding text', async () => {
    const archive = await importArchive([file('sample/thread/messages.json', thread([
      { sender_name: 'Sender', timestamp_ms: 1, content: 'gifs/local.gif' },
      { sender_name: 'Sender', timestamp_ms: 2, content: 'Look https://media.giphy.com/media/Example/giphy.gif great!' },
      { sender_name: 'Sender', timestamp_ms: 3, share: { link: 'https://giphy.com/gifs/Example' } },
      { sender_name: 'Sender', timestamp_ms: 4, content: 'https://malicious.test/fake.gif' },
    ]))])
    const messages = archive.conversations[0].messages
    expect(messages[0].text).toBe('')
    expect(messages[0].attachments[0]).toMatchObject({ uri: 'gifs/local.gif', animated: true, remote: false })
    expect(messages[1].text).toBe('Look  great!')
    expect(messages[1].attachments[0].remote).toBe(true)
    expect(messages[2].link).toBeUndefined()
    expect(messages[2].attachments).toHaveLength(1)
    expect(messages[3].text).toBe('https://malicious.test/fake.gif')
    expect(messages[3].attachments).toHaveLength(0)
  })
})

describe('self confidence', () => {
  const chat = (id: string, partner: string) => file(`sample/messages/inbox/${id}/message.json`, JSON.stringify({
    title: id, participants: [{ name: partner }], messages: [{ sender_name: 'Self', content: 'Hello' }, { sender_name: partner, content: 'Hi' }],
  }))
  it('increases confidence with distinct participant groups and crosses 95% only with enough evidence', async () => {
    const chats = [chat('one', 'Alex'), chat('two', 'Taylor'), chat('three', 'Robin'), chat('four', 'Morgan')]
    const two = await importArchive(chats.slice(0, 2))
    const three = await importArchive(chats.slice(0, 3))
    const four = await importArchive(chats)
    expect(two.selfName).toBe('Self')
    expect(two.selfConfidence).toBeLessThan(0.95)
    expect(three.selfConfidence).toBe(0.95)
    expect(four.selfConfidence).toBeGreaterThan(0.95)
    expect(four.selfConfidence).toBeLessThan(1)
  })
  it('does not let repeated participant groups inflate confidence', async () => {
    const chats = [chat('one', 'Alex'), chat('two', 'Taylor')]
    const base = await importArchive(chats)
    const duplicated = await importArchive([...chats, ...Array.from({ length: 10 }, (_, i) => chat(`copy-${i}`, 'Alex'))])
    expect(duplicated.selfConfidence).toBe(base.selfConfidence)
  })
  it('gives ambiguous and conflicting identities zero confidence', async () => {
    expect((await importArchive([chat('one', 'Alex')])).selfConfidence).toBe(0)
    const conflicting = await importArchive([
      chat('one', 'Alex'), chat('two', 'Taylor'),
      file('sample/owner1.json', JSON.stringify({ owner: { name: 'Self' } })),
      file('sample/owner2.json', JSON.stringify({ owner: { name: 'Alex' } })),
    ])
    expect(conflicting.selfName).toBe('')
    expect(conflicting.selfConfidence).toBe(0)
  })
  it('uses unambiguous explicit owner metadata as certainty', async () => {
    const archive = await importArchive([chat('one', 'Alex'), file('sample/owner.json', JSON.stringify({ owner: { name: 'Self' } }))])
    expect(archive.selfName).toBe('Self')
    expect(archive.selfConfidence).toBe(1)
  })
})
