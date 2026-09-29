import { test, expect, type Page } from '@playwright/test'
import { copyFile, cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gifBytes } from './gif-fixture'

// Entirely synthetic fixtures. Never load the project's private export in browser tests.
let folder: string
let emptyFolder: string

test.beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'meta-chat-synthetic-'))
  emptyFolder = await mkdtemp(join(tmpdir(), 'meta-chat-empty-'))
  const alpha = join(folder, 'messages/inbox/alpha')
  const beta = join(folder, 'messages/message_requests/beta')
  await mkdir(join(alpha, 'photos'), { recursive: true })
  await mkdir(join(alpha, 'audio'), { recursive: true })
  await mkdir(beta, { recursive: true })
  const messages = Array.from({ length: 170 }, (_, i) => ({ sender_name: i % 2 ? 'Alex Example' : 'Jamie Sample', timestamp_ms: Date.UTC(2025, 1, 1, 12, i), content: `Synthetic message ${i}` }))
  messages[3].content = 'An early needle in the archive'
  messages[169].content = '<script>window.unsafe = true</script> These are plain words.'
  const metadata = { title: 'Weekend plans', participants: [{ name: 'Alex Example', profile_picture: { uri: 'photos/pixel.png' } }, { name: 'Jamie Sample' }] }
  await writeFile(join(alpha, 'message_1.json'), JSON.stringify({ ...metadata, messages: [...messages.slice(80), { sender_name: 'Alex Example', timestamp_ms: Date.UTC(2025, 1, 2), photos: [{ uri: 'messages/inbox/alpha/photos/pixel.png' }, { uri: 'messages/inbox/alpha/photos/missing.png' }], audio_files: [{ uri: 'messages/inbox/alpha/audio/tone.wav' }], videos: [{ uri: 'clip.webm' }], reactions: [{ reaction: '👍', actor: 'Jamie Sample' }] }] }))
  await copyFile(new URL('./fixtures/synthetic.webm', import.meta.url), join(alpha, 'clip.webm'))
  await writeFile(join(alpha, 'message_2.json'), JSON.stringify({ ...metadata, messages: messages.slice(0, 80).map((message, index) => index === 3 ? { ...message, gifs: [{ uri: 'photos/animated.gif' }] } : message) }))
  await writeFile(join(alpha, 'photos/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
  await writeFile(join(alpha, 'photos/animated.gif'), gifBytes)
  const wav = Buffer.alloc(8044)
  wav.write('RIFF'); wav.writeUInt32LE(8036, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40); wav.fill(128, 44)
  await writeFile(join(alpha, 'audio/tone.wav'), wav)
  await writeFile(join(beta, 'message_1.json'), JSON.stringify({ title: 'A request', participants: [{ name: 'Taylor Test' }, { name: 'Jamie Sample' }], messages: [{ sender_name: 'Taylor Test', content: 'Hello from another conversation', timestamp_ms: 1 }] }))
  await writeFile(join(folder, 'broken.json'), '{')
  await writeFile(join(emptyFolder, 'metadata.json'), '{}')
})
test.afterAll(async () => { await rm(folder, { recursive: true, force: true }); await rm(emptyFolder, { recursive: true, force: true }) })

async function selectConversationFolder(page: Page, name: 'Inbox' | 'Message requests') {
  await page.getByRole('button', { name: 'Conversation folders', exact: true }).click()
  await page.getByRole('menuitemradio', { name, exact: true }).click()
}
async function showConversationFolder(page: Page, name: 'Weekend plans' | 'A request') {
  await expect(page.locator('.sidebar__actions')).toContainText('Change folder')
  if (!await page.getByRole('button', { name: new RegExp(name) }).count()) {
    await selectConversationFolder(page, name === 'A request' ? 'Message requests' : 'Inbox')
  }
}
async function openConversation(page: Page, name: 'Weekend plans' | 'A request') {
  await showConversationFolder(page, name)
  await page.getByRole('button', { name: new RegExp(name) }).click()
}

async function openShelf(page: Page) {
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  return page.locator('#conversation-shelf')
}
async function closeShelf(page: Page) {
  await page.getByRole('button', { name: 'Close conversation information' }).click()
}
async function showGifs(page: Page) {
  await page.getByRole('button', { name: 'Filter shared assets', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'GIFs', exact: true }).click()
}

test('loads earlier history on scroll, searches from the shelf, and restores reading position', async ({ page }, testInfo) => {
  const errors: string[] = []
  const warnings: string[] = []
  const external: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()) })
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url()) })
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await openConversation(page, 'Weekend plans')
  await expect(page.getByRole('heading', { name: 'Weekend plans' })).toBeVisible()
  const timeline = page.getByLabel('Messages', { exact: true })
  await expect(timeline.locator('.message')).toHaveCount(80)
  await expect(page.getByRole('button', { name: /^(Older|Newer)$/ })).toHaveCount(0)
  await expect(page.getByLabel('Search this conversation')).toHaveCount(0)
  await expect(page.getByText('Attachment unavailable in this folder')).toBeVisible()
  await expect(timeline.locator('audio')).toBeVisible()
  await expect(timeline.locator('audio')).toHaveAttribute('controlslist', 'nodownload')
  await expect(timeline.locator('[download]')).toHaveCount(0)
  await expect(page.getByText('<script>window.unsafe = true</script> These are plain words.')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { unsafe?: boolean }).unsafe)).toBeUndefined()
  const anchor = await timeline.evaluate(element => {
    element.scrollTop = 0
    const first = element.querySelector<HTMLElement>('[data-message-id]')!
    return { id: first.dataset.messageId, offset: first.getBoundingClientRect().top - element.getBoundingClientRect().top }
  })
  await expect(timeline.locator('.message')).toHaveCount(160)
  await expect.poll(() => timeline.evaluate((element, target) => {
    const row = element.querySelector(`[data-message-id="${target.id}"]`)!
    return Math.abs(row.getBoundingClientRect().top - element.getBoundingClientRect().top - target.offset)
  }, anchor)).toBeLessThan(4)
  const shelf = await openShelf(page)
  await shelf.getByLabel('Search this conversation').fill('needle')
  await expect(shelf.getByText('1 of 1', { exact: true })).toBeVisible()
  await shelf.getByRole('button', { name: 'View search result in conversation' }).click()
  await expect(timeline.locator('.message--match')).toContainText('An early needle in the archive')
  await expect(timeline.locator('.message--match')).toBeFocused()
  await expect(timeline.locator('.message')).toHaveCount(171)
  await openShelf(page)
  await shelf.getByRole('button', { name: 'Clear message search' }).click()
  await closeShelf(page)
  await expect(timeline.locator('.message--match')).toHaveCount(0)
  await timeline.evaluate(element => { element.scrollTop = 2000 })
  await expect.poll(() => timeline.evaluate(element => element.scrollTop)).toBeGreaterThan(1900)
  const reading = await timeline.evaluate(element => {
    const row = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.getBoundingClientRect().bottom > element.getBoundingClientRect().top)!
    return { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - element.getBoundingClientRect().top }
  })
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Back to conversations' }).click()
  await openConversation(page, 'A request')
  await expect(page.getByLabel('Messages', { exact: true }).getByText('Hello from another conversation')).toBeVisible()
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Back to conversations' }).click()
  await openConversation(page, 'Weekend plans')
  await expect(timeline.locator('.message')).toHaveCount(171)
  await expect.poll(() => timeline.evaluate((element, saved) => {
    const row = element.querySelector(`[data-message-id="${saved.id}"]`)!
    return Math.abs(row.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset)
  }, reading)).toBeLessThan(4)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  if (testInfo.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 720 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  expect(errors).toEqual([])
  expect(warnings).toEqual([])
  expect(external).toEqual([])
  await page.screenshot({ path: `test-results/synthetic-${testInfo.project.name}.png` })
})

test('filters conversations, switches theme, handles invalid import, and forgets', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-nyx-mode', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-nyx-mode', 'light')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(emptyFolder)
  await expect(page.getByRole('alert').filter({ visible: true })).toContainText('No readable conversations found')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /A request/ })).toHaveCount(0)
  await expect(page.locator('.sidebar__heading > span')).toHaveText('1')
  const folderMenu = page.getByRole('button', { name: 'Conversation folders', exact: true })
  await folderMenu.focus()
  await folderMenu.press('ArrowDown')
  await expect(page.getByRole('menuitemradio')).toHaveCount(2)
  await expect(page.getByRole('menuitemradio', { name: 'Inbox', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('menuitemradio', { name: 'All', exact: true })).toHaveCount(0)
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: 'Message requests', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(folderMenu).toBeFocused()
  await expect(folderMenu).toHaveAttribute('aria-expanded', 'false')
  await showConversationFolder(page, 'A request')
  await expect(page.getByRole('button', { name: /A request/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toHaveCount(0)
  await selectConversationFolder(page, 'Inbox')
  await page.getByLabel('Search conversations').fill('Alex')
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /A request/ })).toHaveCount(0)
  await page.getByLabel('Search conversations').fill('no such person')
  await expect(page.getByText('No conversations match.')).toBeVisible()
  await page.getByLabel('Search conversations').clear()
  await openConversation(page, 'Weekend plans')
  await page.screenshot({ path: `test-results/synthetic-light-${testInfo.project.name}.png` })
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Back to conversations' }).click()
  await page.getByRole('button', { name: 'Forget archive' }).click()
  await expect(page.locator('.archive-status')).toHaveText('No archive selected')
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toHaveCount(0)
})

test('does not serve the private data directory', async ({ request }) => {
  const response = await request.get('/data/.gitkeep')
  expect(response.status()).toBe(403)
})


test('aligns self, uses exported pictures, and browses full-history media in the shelf', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await openConversation(page, 'Weekend plans')
  await expect(page.locator('.message--self').first()).toContainText('You')
  const own = await page.locator('.message--self').first().boundingBox()
  const other = await page.locator('.message:not(.message--self)').first().boundingBox()
  expect(own!.x).toBeGreaterThan(other!.x)
  await expect(page.locator('.chat__header .nyx-avatar img')).toHaveAttribute('src', /^blob:/)
  await expect(page.locator('.message:not(.message--self) .nyx-avatar img').first()).toHaveAttribute('src', /^blob:/)
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  const shelf = page.locator('#conversation-shelf')
  await expect(shelf).toBeVisible()
  await expect(shelf.getByRole('heading', { name: /Photos & videos/ })).toBeVisible()
  await expect(shelf.locator('.attachment--gif')).toHaveCount(0)
  await expect(shelf.locator('[download]')).toHaveCount(0)
  await showGifs(page)
  // This animation predates the initially rendered history.
  await shelf.locator('.attachment--gif').scrollIntoViewIfNeeded()
  await expect(shelf.locator('.attachment--gif img')).toHaveAttribute('src', /^blob:/)
  await expect(shelf.locator('.attachment--gif img')).toBeVisible()
  await shelf.getByRole('button', { name: 'Go to original message' }).last().click()
  await expect(shelf).toHaveCount(0)
  await expect(page.getByLabel('Messages', { exact: true }).locator('.message')).toHaveCount(171)
  await expect(page.locator('.message--match')).toContainText('An early needle in the archive')
  await expect(page.locator('.message--match .attachment--gif img')).toBeVisible()
  await expect(page.locator('.message--match')).toBeFocused()
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  await shelf.getByRole('button', { name: 'Set Alex Example as yourself' }).click()
  await shelf.getByRole('button', { name: 'Close conversation information' }).click()
  await expect(page.getByRole('button', { name: 'Conversation information', exact: true })).toBeFocused()
  await expect(page.locator('.message--self').first()).toContainText('Synthetic message 1')
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(shelf).toHaveCount(0)
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Back to conversations' }).click()
  await openConversation(page, 'A request')
  await expect(page.locator('.message--self')).toHaveCount(0)
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Back to conversations' }).click()
  await openConversation(page, 'Weekend plans')
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  await page.screenshot({ path: `test-results/synthetic-shelf-${testInfo.project.name}.png` })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('auto-loads verified GIFs, blocks disguised responses and redirects, and never fetches arbitrary URLs', async ({ page }) => {
  const local = await mkdtemp(join(tmpdir(), 'meta-chat-gifs-'))
  const requests: string[] = []
  page.on('request', request => { if (request.url().startsWith('https:')) requests.push(request.url()) })
  await page.route('https://media.giphy.com/**', async route => {
    const url = route.request().url()
    if (url.includes('/invalid/')) await route.fulfill({ contentType: 'image/gif', body: '<html>not a GIF</html>' })
    else if (url.includes('/redirect/')) await route.fulfill({ status: 302, headers: { location: 'https://untrusted.test/payload.gif' } })
    else await route.fulfill({ contentType: 'image/gif', body: Buffer.from(gifBytes) })
  })
  try {
    await writeFile(join(local, 'message.json'), JSON.stringify({ title: 'GIF test', participants: [{ name: 'Example' }], messages: [
      { sender_name: 'Example', timestamp_ms: 1, content: 'https://media.giphy.com/media/valid/giphy.gif' },
      { sender_name: 'Example', timestamp_ms: 2, content: 'https://untrusted.test/payload.gif' },
      { sender_name: 'Example', timestamp_ms: 3, content: 'https://media.giphy.com/media/invalid/giphy.gif' },
      { sender_name: 'Example', timestamp_ms: 4, content: 'https://media.giphy.com/media/redirect/giphy.gif' },
    ] }))
    await page.goto('/')
    await page.getByLabel('Choose Instagram export folder').setInputFiles(local)
    await page.getByRole('button', { name: /GIF test/ }).click()
    await expect(page.locator('.attachment--gif img')).toHaveCount(1)
    await expect(page.locator('.attachment--gif img')).toBeVisible()
    await expect(page.locator('.attachment--gif img')).toHaveAttribute('src', /^blob:/)
    await expect(page.getByText('GIF unavailable or could not be verified.')).toHaveCount(2)
    await expect(page.locator('.attachment [download]')).toHaveCount(0)
    await expect(page.locator('.attachment__gif-label')).toHaveCount(0)
    expect(requests).toHaveLength(3)
    expect(requests.every(url => new URL(url).hostname === 'media.giphy.com')).toBe(true)
    await expect(page.getByLabel('Messages', { exact: true }).getByText('https://untrusted.test/payload.gif')).toBeVisible()
  } finally { await rm(local, { recursive: true, force: true }) }
})


test('uses an accessible single-select asset menu and loads all messages without moving the reader', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await openConversation(page, 'Weekend plans')
  const timeline = page.getByLabel('Messages', { exact: true })
  const shelf = await openShelf(page)
  await expect(shelf.getByText('80 of 171 messages loaded')).toBeVisible()
  await expect(shelf.locator('.conversation-info__media > li')).toHaveCount(3)
  await expect(shelf.locator('audio')).toHaveCount(0)
  await expect(shelf.getByRole('tab')).toHaveCount(0)
  const grid = shelf.locator('.conversation-info__media--visual')
  expect(await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(3)
  const jump = grid.getByRole('button', { name: 'Go to original message' }).first()
  await jump.focus()
  await expect(page.getByRole('tooltip', { name: 'View message', exact: true })).toBeVisible()
  expect(await jump.textContent()).toBe('')
  const tileBounds = await grid.locator('li').first().boundingBox()
  const jumpBounds = await jump.boundingBox()
  expect(Math.abs(tileBounds!.x + tileBounds!.width - jumpBounds!.x - jumpBounds!.width)).toBeLessThan(5)
  expect(Math.abs(tileBounds!.y + tileBounds!.height - jumpBounds!.y - jumpBounds!.height)).toBeLessThan(5)
  await page.keyboard.press('Escape')
  const menuTrigger = shelf.getByRole('button', { name: 'Filter shared assets', exact: true })
  await menuTrigger.focus()
  await page.keyboard.press('ArrowDown')
  const photos = page.getByRole('menuitemradio', { name: 'Photos & videos', exact: true })
  const gifs = page.getByRole('menuitemradio', { name: 'GIFs', exact: true })
  await expect(photos).toBeFocused()
  await expect(photos).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(gifs).toBeFocused()
  await page.keyboard.press('Space')
  await expect(shelf.getByRole('heading', { name: /GIFs/ })).toBeVisible()
  await expect(shelf.locator('.conversation-info__media > li')).toHaveCount(1)
  await expect(shelf.locator('video')).toHaveCount(0)
  await expect(menuTrigger).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(photos).toHaveAttribute('aria-checked', 'false')
  await expect(gifs).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(menuTrigger).toBeFocused()
  await expect(shelf).toBeVisible()
  await shelf.getByRole('button', { name: 'Load all', exact: true }).click()
  await expect(shelf.getByText('All messages loaded')).toBeVisible()
  await expect(shelf.getByRole('button', { name: 'Load all', exact: true })).toBeDisabled()
  await closeShelf(page)
  await expect(timeline.locator('.message')).toHaveCount(171)
  await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(5)
  await openShelf(page)
  await expect(shelf.getByRole('heading', { name: /Photos & videos/ })).toBeVisible()
  await expect(shelf.locator('.attachment [download]')).toHaveCount(0)
  await page.screenshot({ path: `test-results/synthetic-refined-shelf-${testInfo.project.name}.png` })
})

test('opens visual assets with contextual navigation, playback, and focus restoration', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  const exportLink = page.getByRole('link', { name: 'Request a new export' }).filter({ visible: true })
  await expect(exportLink).toHaveAttribute('href', 'https://accountscenter.facebook.com/info_and_permissions/dyi')
  await expect(exportLink).toHaveAttribute('target', '_blank')
  await expect(exportLink).toHaveAttribute('rel', 'noopener noreferrer')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await openConversation(page, 'Weekend plans')
  const timeline = page.getByLabel('Messages', { exact: true })
  const photo = timeline.getByRole('button', { name: 'Open photo', exact: true })
  await photo.click()
  const modal = page.getByRole('dialog', { name: 'Media viewer', exact: true })
  await expect(modal).toBeVisible()
  await expect(modal.getByRole('status')).toHaveText('2 of 3')
  await expect(modal.getByRole('button', { name: 'Close media viewer' })).toBeFocused()
  await expect(modal.locator('img')).toHaveAttribute('src', /^blob:/)
  await page.keyboard.press('ArrowLeft')
  // The GIF predates the chat's initial 80 messages, yet is part of its gallery.
  await expect(modal.getByRole('status')).toHaveText('1 of 3')
  await expect(modal.locator('.attachment--gif img')).toBeVisible()
  await expect(modal.getByRole('button', { name: 'Previous asset' })).toBeDisabled()
  await modal.getByRole('button', { name: 'Next asset' }).click()
  await modal.getByRole('button', { name: 'Next asset' }).click()
  await expect(modal.getByRole('status')).toHaveText('3 of 3')
  const video = modal.locator('video')
  await expect(video).toBeVisible()
  await expect(video).toHaveAttribute('controls', '')
  await expect(video).toHaveAttribute('controlslist', 'nodownload')
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThan(1)
  await video.evaluate(element => (element as HTMLVideoElement).play())
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
  await expect(modal.getByRole('button', { name: 'Next asset' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(photo).toBeFocused()
  await timeline.getByRole('button', { name: 'Open video', exact: true }).click()
  await expect(modal.getByRole('status')).toHaveText('3 of 3')
  await modal.getByRole('button', { name: 'Close media viewer' }).click()
  const shelf = await openShelf(page)
  await shelf.locator('.conversation-info__media').scrollIntoViewIfNeeded()
  const shelfPhoto = shelf.getByRole('button', { name: 'Open photo', exact: true })
  await shelfPhoto.click()
  await expect(modal.getByRole('status')).toHaveText('2 of 2')
  await expect(modal.getByRole('button', { name: 'Next asset' })).toBeDisabled()
  await modal.getByRole('button', { name: 'Previous asset' }).click()
  await expect(modal.locator('video')).toBeVisible()
  await expect(modal.getByRole('status')).toHaveText('1 of 2')
  await expect(modal.getByRole('button', { name: 'Previous asset' })).toBeDisabled()
  await expect(modal.locator('.attachment--gif')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(shelf).toBeVisible()
  await expect(shelfPhoto).toBeFocused()
  await showGifs(page)
  await shelf.getByRole('button', { name: 'Open GIF', exact: true }).click()
  await expect(modal.locator('.attachment--gif img')).toBeVisible()
  await expect(modal.getByRole('status')).toHaveText('1 of 1')
  await expect(modal.getByRole('button', { name: 'Next asset' })).toBeDisabled()
  await expect(modal.getByRole('button', { name: 'Previous asset' })).toBeDisabled()
  await expect(modal.locator('[download]')).toHaveCount(0)
  await page.screenshot({ path: `test-results/synthetic-lightbox-${testInfo.project.name}.png` })
  await page.keyboard.press('Escape')
  await closeShelf(page)
  await expect(timeline.locator('.message')).toHaveCount(80)
  expect(errors).toEqual([])
})

test('includes shelf assets beyond the visible batch without including other categories', async ({ page }) => {
  const local = await mkdtemp(join(tmpdir(), 'meta-chat-gallery-'))
  try {
    await copyFile(join(folder, 'messages/inbox/alpha/photos/pixel.png'), join(local, 'photo.png'))
    await copyFile(join(folder, 'messages/inbox/alpha/photos/animated.gif'), join(local, 'animated.gif'))
    await writeFile(join(local, 'message.json'), JSON.stringify({ title: 'Gallery example', participants: [{ name: 'Example' }], messages: [
      { sender_name: 'Example', timestamp_ms: 1, photos: Array.from({ length: 25 }, () => ({ uri: 'photo.png' })), gifs: [{ uri: 'animated.gif' }] },
    ] }))
    await page.goto('/')
    await page.getByLabel('Choose Instagram export folder').setInputFiles(local)
    await page.getByRole('button', { name: /Gallery example/ }).click()
    const shelf = await openShelf(page)
    await expect(shelf.locator('.conversation-info__media > li')).toHaveCount(24)
    await shelf.locator('.conversation-info__media > li').first().scrollIntoViewIfNeeded()
    await shelf.getByRole('button', { name: 'Open photo', exact: true }).first().click()
    const modal = page.getByRole('dialog', { name: 'Media viewer', exact: true })
    await expect(modal.getByRole('status')).toHaveText('1 of 25')
    for (let i = 0; i < 24; i++) await page.keyboard.press('ArrowRight')
    await expect(modal.getByRole('status')).toHaveText('25 of 25')
    await expect(modal.locator('img')).toBeVisible()
    await expect(modal.getByRole('button', { name: 'Next asset' })).toBeDisabled()
    await expect(modal.locator('.attachment--gif')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(shelf).toBeVisible()
  } finally { await rm(local, { recursive: true, force: true }) }
})

test('restores conversations and local media after refresh, and forgets the complete cached archive', async ({ page }, testInfo) => {
  await page.goto('/')
  const selected = await mkdtemp(join(tmpdir(), 'meta-chat-detached-cache-'))
  try {
    await cp(folder, selected, { recursive: true })
    await writeFile(join(selected, 'payload.bin'), Buffer.alloc(4 * 1024 * 1024 + 3, 127))
    await page.getByLabel('Choose Instagram export folder').setInputFiles(selected)
    await expect(page.locator('.archive-status')).toHaveText('Saved in this browser')
  } finally { await rm(selected, { recursive: true, force: true }) }
  // Restore must read cached bytes even when the selected source no longer exists.
  await page.reload()
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toBeVisible()
  await showConversationFolder(page, 'A request')
  await expect(page.getByRole('button', { name: /A request/ })).toBeVisible()
  const cachedBytes = await page.evaluate(async () => {
    const modulePath = '/src/lib/archive-storage.ts'
    const { restoreArchive } = await import(/* @vite-ignore */ modulePath)
    const files: File[] = await restoreArchive()
    const file = files.find(file => file.name === 'payload.bin')!
    const bytes = new Uint8Array(await file.arrayBuffer())
    return { size: bytes.length, intact: bytes.every(byte => byte === 127) }
  })
  expect(cachedBytes).toEqual({ size: 4 * 1024 * 1024 + 3, intact: true })
  expect(await page.getByLabel('Choose Instagram export folder').evaluate(input => (input as HTMLInputElement).files?.length)).toBe(0)
  await openConversation(page, 'Weekend plans')
  await expect(page.locator('.chat__header .nyx-avatar img')).toHaveAttribute('src', /^blob:/)
  const timeline = page.getByLabel('Messages', { exact: true })
  await expect(timeline.getByRole('button', { name: 'Open photo', exact: true })).toBeVisible()
  await expect(timeline.locator('audio')).toHaveAttribute('src', /^blob:/)
  await expect(timeline.locator('video')).toHaveAttribute('src', /^blob:/)
  const shelf = await openShelf(page)
  await showGifs(page)
  await shelf.locator('.attachment--gif').scrollIntoViewIfNeeded()
  await expect(shelf.locator('.attachment--gif img')).toHaveAttribute('src', /^blob:/)
  await closeShelf(page)
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Back to conversations' }).click()
  await page.getByRole('button', { name: 'Forget archive', exact: true }).click()
  await expect(page.locator('.archive-status')).toHaveText('No archive selected')
  const counts = await page.evaluate(() => new Promise<number[]>((resolve, reject) => {
    const request = indexedDB.open('meta-chat-archive', 1)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(['files', 'metadata'])
      const files = tx.objectStore('files').count()
      const metadata = tx.objectStore('metadata').count()
      tx.oncomplete = () => { db.close(); resolve([files.result, metadata.result]) }
      tx.onabort = () => { db.close(); reject(new Error('Could not inspect synthetic cache')) }
    }
    request.onerror = () => reject(new Error('Could not inspect synthetic cache'))
  }))
  expect(counts).toEqual([0, 0])
  await page.reload()
  await expect(page.getByRole('button', { name: 'Open folder', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Forget archive', exact: true })).toHaveCount(0)
  // Forgetting removes only the browser copy: the original fixture can be read again.
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await expect(page.locator('.archive-status')).toHaveText('Saved in this browser')
})

test('replaces saved archives atomically and keeps browsing after a quota failure', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await expect(page.locator('.archive-status')).toHaveText('Saved in this browser')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(join(folder, 'messages/message_requests/beta'))
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toHaveCount(0)
  await expect(page.locator('.archive-status')).toHaveText('Saved in this browser')
  await page.reload()
  await showConversationFolder(page, 'A request')
  await expect(page.getByRole('button', { name: /A request/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toHaveCount(0)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'files') throw new DOMException('Synthetic quota failure', 'QuotaExceededError')
      return put.apply(this, args)
    }
  })
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await expect(page.getByRole('status').filter({ visible: true }).filter({ hasText: 'Not enough browser storage' })).toContainText('previously saved archive may reopen')
  await openConversation(page, 'Weekend plans')
  await expect(page.getByRole('heading', { name: 'Weekend plans', exact: true })).toBeVisible()
  await page.reload()
  await showConversationFolder(page, 'A request')
  await expect(page.getByRole('button', { name: /A request/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toHaveCount(0)
})

test('rejects a corrupt snapshot and allows removing it', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await expect(page.locator('.archive-status')).toHaveText('Saved in this browser')
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('meta-chat-archive', 1)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('metadata', 'readwrite')
      tx.objectStore('metadata').put({ version: 999, count: 1 }, 'archive')
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(new Error('Could not modify synthetic cache')) }
    }
  }))
  await page.reload()
  await expect(page.getByRole('status').filter({ visible: true }).filter({ hasText: 'Saved archive could not be restored' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Forget archive', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Forget archive', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Open folder', exact: true })).toBeEnabled()
  await expect(page.getByText('Saved archive could not be restored', { exact: false })).toHaveCount(0)
})

test('can read a folder when browser storage is unavailable and reports deletion failures honestly', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Synthetic denied storage', 'SecurityError') } })
  })
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await expect(page.getByRole('status').filter({ visible: true }).filter({ hasText: 'could not be saved in this browser' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toBeVisible()
  await page.getByRole('button', { name: 'Forget archive', exact: true }).click()
  await expect(page.getByRole('status').filter({ visible: true }).filter({ hasText: 'saved archive could not be removed' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Forget archive', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('aborting a cache replacement preserves the previous committed files', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await expect(page.locator('.archive-status')).toHaveText('Saved in this browser')
  const result = await page.evaluate(async () => {
    const modulePath = '/src/lib/archive-storage.ts'
    const { saveArchive } = await import(/* @vite-ignore */ modulePath)
    const abort = new AbortController()
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args)
      if (this.name === 'files') queueMicrotask(() => abort.abort())
      return request
    }
    try {
      await saveArchive([new File(['synthetic'], 'cancelled.json')], abort.signal)
      return 'unexpected success'
    } catch (error) { return (error as Error).name }
    finally { IDBObjectStore.prototype.put = put }
  })
  expect(result).toBe('AbortError')
  await page.reload()
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toBeVisible()
  await showConversationFolder(page, 'A request')
  await expect(page.getByRole('button', { name: /A request/ })).toBeVisible()
})

test('retains conversation URLs through reload and browser history, and saves the shelf preference', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await expect(page.locator('.archive-status')).toContainText('Saved in this browser')
  await openConversation(page, 'Weekend plans')
  await expect(page).toHaveURL(/#\/conversation\/[a-f0-9]{64}$/)
  const firstUrl = page.url()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Weekend plans' })).toBeVisible()
  await expect(page).toHaveURL(firstUrl)

  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Back to conversations' }).click()
  await openConversation(page, 'A request')
  await expect(page.getByRole('heading', { name: 'A request', exact: true, level: 2 })).toBeVisible()
  const secondUrl = page.url()
  expect(secondUrl).not.toBe(firstUrl)
  await page.goBack()
  if (testInfo.project.name === 'mobile') {
    await expect(page).toHaveURL(/#\/$/)
    await page.goBack()
  }
  await expect(page).toHaveURL(firstUrl)
  await expect(page.getByRole('heading', { name: 'Weekend plans' })).toBeVisible()
  await page.goForward()
  if (testInfo.project.name === 'mobile') await page.goForward()
  await expect(page).toHaveURL(secondUrl)
  await expect(page.getByRole('heading', { name: 'A request', exact: true, level: 2 })).toBeVisible()

  await openShelf(page)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('meta-chat:shelf-open'))).toBe('true')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'A request', exact: true, level: 2 })).toBeVisible()
  await expect(page.locator('#conversation-shelf')).toBeVisible()
  if (testInfo.project.name === 'desktop') {
    await openConversation(page, 'Weekend plans')
    await expect(page.locator('#conversation-shelf')).toBeVisible()
    await expect(page).toHaveURL(firstUrl)
  }
  await closeShelf(page)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('meta-chat:shelf-open'))).toBe('false')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Conversation information', exact: true })).toBeVisible()
  await expect(page.locator('#conversation-shelf')).toHaveCount(0)

  // A bookmark for a conversation absent from this archive falls back to the list.
  await page.goto('/#/conversation/' + '0'.repeat(64))
  await expect(page).toHaveURL(/#\/$/)
  await showConversationFolder(page, 'Weekend plans')
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toBeVisible()
  await openConversation(page, 'Weekend plans')
  if (testInfo.project.name === 'desktop') {
    await page.getByRole('button', { name: 'Forget archive', exact: true }).click()
    await expect(page).toHaveURL(/#\/$/)
    await expect(page.locator('.archive-status')).toContainText('No archive selected')
  }
})

test('hides extended messages by default, preserves media, and toggles accessible history and search', async ({ page }, testInfo) => {
  const extendedFolder = await mkdtemp(join(tmpdir(), 'meta-chat-extended-synthetic-'))
  try {
    await cp(folder, extendedFolder, { recursive: true })
    await writeFile(join(extendedFolder, 'messages/inbox/alpha/message_3.json'), JSON.stringify({
      title: 'Weekend plans', participants: [{ name: 'Alex Example' }, { name: 'Jamie Sample' }],
      messages: [
        ...Array.from({ length: 120 }, (_, index) => ({ sender_name: 'Alex Example', content: 'Liked a message', timestamp_ms: Date.UTC(2025, 1, 3, 0, index) })),
        { sender_name: 'Alex Example', content: 'Reacted 😂 to your message', timestamp_ms: Date.UTC(2025, 1, 4) },
        { sender_name: 'Alex Example', content: 'Alex Example sent an attachment.', timestamp_ms: Date.UTC(2025, 1, 5), photos: [{ uri: 'photos/pixel.png' }] },
        { sender_name: 'Jamie Sample', content: 'A heart ❤ for you', timestamp_ms: Date.UTC(2025, 1, 6), reactions: [{ actor: 'Alex Example', reaction: '❤' }] },
        { sender_name: 'Alex Example', content: 'Liked a message', timestamp_ms: Date.UTC(2025, 1, 7) },
      ],
    }))
    await page.goto('/')
    await page.getByLabel('Choose Instagram export folder').setInputFiles(extendedFolder)
    await expect(page.locator('.archive-status')).toContainText('Saved in this browser')
    await expect(page.locator('.conversation__preview').first()).toHaveText('A heart ❤️ for you')
    await openConversation(page, 'Weekend plans')
    const timeline = page.getByLabel('Messages', { exact: true })
    await expect(timeline.locator('.message')).toHaveCount(80)
    await expect(timeline.getByText('Liked a message', { exact: true })).toHaveCount(0)
    await expect(timeline.getByText('Reacted 😂 to your message', { exact: true })).toHaveCount(0)
    await expect(timeline.getByText('Alex Example sent an attachment.', { exact: true })).toHaveCount(0)
    await expect(timeline.getByText('A heart ❤️ for you', { exact: true })).toBeVisible()
    await expect(timeline.getByLabel('❤️ from Alex Example')).toHaveText('❤️')
    await expect(page.locator('.chat__footer .archive-status')).toBeVisible()
    await expect(page.locator('.chat__footer .archive-status')).toHaveText('Saved in this browser')
    await expect(page.locator('.sidebar .archive-status')).toHaveCount(0)
    await expect(page.getByText('Linked GIFs load from verified providers')).toHaveCount(0)
    const shelf = await openShelf(page)
    const toggle = shelf.getByRole('switch', { name: 'Extended messages' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await shelf.getByLabel('Search this conversation').fill('Liked a message')
    await expect(shelf.getByText('No matches', { exact: true })).toBeVisible()
    await toggle.focus()
    await toggle.press('Space')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(shelf.getByText('1 of 121', { exact: true })).toBeVisible()
    await closeShelf(page)
    await expect(timeline.getByText('Alex Example sent an attachment.', { exact: true })).toHaveCount(1)
    await expect(timeline.getByText('Reacted 😂 to your message', { exact: true })).toHaveCount(1)
    await openShelf(page)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(shelf.getByText('No matches', { exact: true })).toBeVisible()
    await shelf.getByRole('button', { name: 'Clear message search' }).click()
    await shelf.locator('.conversation-info__tile-jump').first().click()
    const focused = timeline.locator('.message--match')
    await expect(focused).toBeFocused()
    await expect(focused.getByRole('button', { name: 'Open photo' }).locator('img')).toBeVisible()
    await expect(focused.locator('.message__text')).toHaveCount(0)
    await expect(timeline.getByText('Liked a message', { exact: true })).toHaveCount(0)
    await openShelf(page)
    await page.screenshot({ path: `test-results/extended-messages-${testInfo.project.name}-synthetic.png` })
  } finally { await rm(extendedFolder, { recursive: true, force: true }) }
})

test('keeps identity correction at 95% and hides it above 95%, including after restore', async ({ page }, testInfo) => {
  const identityFolder = await mkdtemp(join(tmpdir(), 'meta-chat-identity-synthetic-'))
  try {
    await cp(folder, identityFolder, { recursive: true })
    async function addChat(id: string, partner: string) {
      const directory = join(identityFolder, 'messages/inbox', id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'message_1.json'), JSON.stringify({
        title: `Synthetic ${id}`, participants: [{ name: 'Jamie Sample' }, { name: partner }],
        messages: [{ sender_name: 'Jamie Sample', content: 'Hello', timestamp_ms: 1 }, { sender_name: partner, content: 'Hi', timestamp_ms: 2 }],
      }))
    }
    await addChat('third', 'Robin Example')
    await page.goto('/')
    await page.getByLabel('Choose Instagram export folder').setInputFiles(identityFolder)
    await openConversation(page, 'Weekend plans')
    const shelf = await openShelf(page)
    await expect(shelf.getByRole('button', { name: 'Set Alex Example as yourself' })).toBeVisible()
    await expect(shelf.getByLabel('Your account')).toHaveCount(1)
    await closeShelf(page)
    if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Back to conversations' }).click()
    await addChat('fourth', 'Morgan Example')
    await page.getByLabel('Choose Instagram export folder').setInputFiles(identityFolder)
    await expect(page.locator('.sidebar__heading > span')).toHaveText('3')
    await expect(page.locator('.archive-status')).toHaveText('Saved in this browser')
    await openConversation(page, 'Weekend plans')
    await openShelf(page)
    await expect(shelf.getByRole('button', { name: /as yourself/ })).toHaveCount(0)
    await expect(shelf.getByLabel('Your account')).toHaveCount(0)
    await expect(shelf.getByText('Alex Example', { exact: true })).toBeVisible()
    await page.reload()
    await expect(shelf).toBeVisible()
    await expect(shelf.getByRole('button', { name: /as yourself/ })).toHaveCount(0)
    await expect(shelf.getByLabel('Your account')).toHaveCount(0)
  } finally { await rm(identityFolder, { recursive: true, force: true }) }
})

test('collapses shelf sections independently and keeps history controls in search-first order', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await openConversation(page, 'Weekend plans')
  const shelf = await openShelf(page)
  const participants = shelf.getByRole('button', { name: /^Participants/ })
  const history = shelf.getByRole('button', { name: 'History', exact: true })
  const shared = shelf.getByRole('button', { name: 'Shared assets', exact: true })
  for (const trigger of [participants, history, shared]) await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(await shelf.locator('.conversation-info__history').evaluate(element => {
    const search = element.querySelector('.conversation-info__search')!
    const extended = element.querySelector('.conversation-info__extended')!
    return !!(search.compareDocumentPosition(extended) & Node.DOCUMENT_POSITION_FOLLOWING)
  })).toBe(true)
  const search = shelf.getByLabel('Search this conversation')
  await search.fill('needle')
  await shelf.getByRole('switch', { name: 'Extended messages' }).click()
  await history.click()
  await expect(history).toHaveAttribute('aria-expanded', 'false')
  await expect(search).toBeHidden()
  await expect(shelf.locator('.conversation-info__summary')).toBeVisible()
  await expect(shelf.locator('.conversation-info__shared')).toBeVisible()
  await history.press('Space')
  await expect(search).toBeVisible()
  await expect(search).toHaveValue('needle')
  await expect(shelf.getByRole('switch', { name: 'Extended messages' })).toHaveAttribute('aria-checked', 'true')
  await showGifs(page)
  await shared.click()
  await expect(shelf.getByRole('button', { name: 'Filter shared assets', exact: true })).toBeHidden()
  await shared.press('Home')
  await expect(participants).toBeFocused()
  await participants.press('Enter')
  await expect(shelf.locator('.conversation-info__people')).toBeHidden()
  await expect(shelf.locator('.conversation-info__summary')).toBeVisible()
  await expect(shelf.locator('.nyx-accordion .conversation-info__summary')).toHaveCount(0)
  await expect(history).toHaveAttribute('aria-expanded', 'true')
  await participants.press('End')
  await expect(shared).toBeFocused()
  await shared.press('Enter')
  await expect(shelf.getByRole('heading', { name: /^GIFs/ })).toBeVisible()
  await page.screenshot({ path: `test-results/accordion-${testInfo.project.name}-synthetic.png` })
})
