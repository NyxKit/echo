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
  await writeFile(join(alpha, 'photos/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'))
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
async function openSettings(page: Page) {
  if (new URL(page.url()).hash === '#/settings') return
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  if (!await settings.isVisible()) await page.getByRole('button', { name: 'Back to conversations', exact: true }).click()
  await settings.click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
}
async function showConversationFolder(page: Page, name: 'Weekend plans' | 'A request') {
  await expect(page.locator('.sidebar__heading > span')).toHaveText(/^[1-9]\d*$/)
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

test('connects ChatGPT from the Ask Echo shelf without sending archive content', async ({ page, context }) => {
  let connected = false
  let checks = 0
  const actions: string[] = []
  await context.route('https://auth.openai.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Synthetic sign-in page</p>' }))
  await page.route('**/api/chatgpt/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)!
    actions.push(action)
    expect(route.request().postData()).toBeNull()
    if (action === 'login') return route.fulfill({ json: { url: 'https://auth.openai.com/api/accounts/authorize?state=synthetic-state' } })
    if (action === 'models') return route.fulfill({ json: { models: [{ id: 'gpt-6.1-sol', name: 'Synthetic model' }] } })
    if (action === 'check') { checks++; return route.fulfill({ json: { state: 'connected', checked: true } }) }
    if (action === 'disconnect') connected = false
    return route.fulfill({ json: { state: connected ? 'connected' : 'disconnected' } })
  })
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await openConversation(page, 'Weekend plans')
  await page.getByRole('button', { name: 'Ask Echo', exact: true }).click()
  await expect(page.getByLabel('Ask about this conversation')).toBeFocused()
  await page.getByRole('button', { name: 'Close ask echo', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Ask Echo', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Ask Echo', exact: true }).click()
  await expect(page.getByLabel('Ask about this conversation')).toBeFocused()
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  await page.getByLabel('Ask about this conversation').fill('Synthetic question')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible()
  expect(checks).toBe(0)
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click()
  const popup = await popupPromise
  await expect(popup.getByText('Synthetic sign-in page')).toBeVisible()
  await expect(page.getByText('Finish signing in in the ChatGPT tab, then return here.')).toBeVisible()
  connected = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByText('Connected to ChatGPT.', { exact: true })).toBeVisible()
  expect(checks).toBe(0)
  await page.getByRole('button', { name: 'Check connection', exact: true }).click()
  await expect(page.getByText('Connection checked. ChatGPT can respond.')).toBeVisible()
  expect(checks).toBe(1)
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Connect ChatGPT', exact: true })).not.toBeVisible()
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).not.toBeVisible()
  expect(actions).toContain('login')
  expect(actions).toContain('disconnect')
})

async function enableDeveloperMode(page: Page) {
  await page.getByRole('button', { name: 'Ask Echo settings', exact: true }).click()
  await page.getByText('Developer mode', { exact: true }).click()
  await page.goBack()
}

async function inspectContext(page: Page) {
  await page.getByRole('button', { name: 'Inspect context', exact: true }).click()
}

test('recovers an empty model list after a successful connection check and prepares analysis', async ({ page }) => {
  let checked = false
  let sends = 0
  await page.route('**/api/chatgpt/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)
    if (action === 'check') checked = true
    if (action === 'models') return route.fulfill({ json: { models: checked ? [{ id: 'synthetic-account-model', name: 'Account model' }] : [] } })
    if (action === 'analyze') {
      sends++
      expect(route.request().postDataJSON().model).toBe('synthetic-account-model')
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"delta","delta":"Synthetic answer."}\n\ndata: {"type":"complete"}\n\n' })
    }
    return route.fulfill({ json: { state: 'connected' } })
  })
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await openConversation(page, 'Weekend plans')
  await page.locator('.message__text').filter({ hasText: 'Synthetic message 160' }).click()
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.getByRole('button', { name: 'Ask Echo settings', exact: true }).click()
  const settings = page.getByRole('region', { name: 'ChatGPT settings', exact: true })
  await expect(settings).toContainText('ChatGPT returned no available models.')
  await expect(settings.getByRole('button', { name: 'Refresh models', exact: true })).toBeVisible()
  await settings.getByRole('button', { name: 'Check connection', exact: true }).click()
  await expect(settings).toContainText('Connection checked. ChatGPT can respond.')
  await expect(settings.getByRole('combobox', { name: 'Default model', exact: true })).toHaveValue('Account model')
  await expect(settings).not.toContainText('ChatGPT returned no available models.')
  await page.goBack()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Review sharing', exact: true })).toHaveCount(0)
  await expect(page.locator('.analysis-answer')).toContainText('Synthetic answer.')
  expect(sends).toBe(1)
})

test('selects ranges, sends full context directly, and keeps follow-up history in its discussion', async ({ page }, testInfo) => {
  const sent: any[] = []
  await page.route('**/api/chatgpt/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)
    if (action === 'models') return route.fulfill({ json: { models: [{ id: 'gpt-6.1-sol', name: 'Synthetic model' }] } })
    if (action === 'analyze') {
      sent.push(route.request().postDataJSON())
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"delta","delta":"Synthetic interpretation [[p1:m81]]."}\n\ndata: {"type":"complete"}\n\n' })
    }
    return route.fulfill({ json: { state: 'connected' } })
  })
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await openConversation(page, 'Weekend plans')
  const message = (text: string) => page.locator('.message').filter({ has: page.getByText(text, { exact: true }) })
  const returnToTimeline = async () => {
    if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Close ask echo', exact: true }).click()
  }
  await message('Synthetic message 160').click()
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  if (testInfo.project.name === 'desktop') await expect(message('Synthetic message 160')).toBeFocused()
  await returnToTimeline()
  await message('Synthetic message 162').click({ modifiers: ['Shift'] })
  await expect(page.locator('.message--selected')).toHaveCount(3)
  await expect(message('Synthetic message 161')).toHaveClass(/message--selected/)
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  await returnToTimeline()
  await message('Synthetic message 163').focus()
  await page.keyboard.press('Shift+Enter')
  await expect(page.locator('.message--selected')).toHaveCount(4)
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  await returnToTimeline()
  await message('Synthetic message 163').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.message--selected')).toHaveCount(3)
  if (testInfo.project.name === 'mobile') {
    await expect(page.locator('#analysis-shelf')).toHaveCount(0)
    await page.getByRole('button', { name: 'Ask Echo', exact: true }).click()
  }
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  expect(sent).toHaveLength(0)
  const question = page.getByLabel('Ask about this conversation')
  await expect(page.getByRole('list', { name: 'Selected messages' }).getByRole('listitem')).toHaveCount(3)
  await page.getByRole('button', { name: 'Remove selected message 3', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Selected messages' }).getByRole('listitem')).toHaveCount(2)
  await expect(message('Synthetic message 162')).not.toHaveClass(/message--selected/)
  await question.fill('First line')
  await question.press('Shift+Enter')
  await question.press('a')
  await expect(question).toHaveValue('First line\na')
  await question.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await expect(page.getByRole('dialog', { name: 'Review sharing', exact: true })).not.toBeVisible()
  await page.getByRole('button', { name: 'Context: Surrounding week', exact: true }).click()
  await page.getByRole('menuitem', { name: 'All time', exact: true }).click()
  await question.fill('Explain the selected exchange.')
  await question.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Review sharing', exact: true })).toHaveCount(0)
  await expect(page.locator('.analysis-answer')).toContainText('Synthetic interpretation')
  await expect(question).toBeFocused()
  expect(sent).toHaveLength(1)
  expect(sent[0].turn.focus).toHaveLength(2)
  expect(sent[0].sourceParts.map((part: string) => JSON.parse(part).messages.length).reduce((a: number, b: number) => a + b, 0)).toBe(171)
  expect(sent[0].history).toHaveLength(0)
  await expect(page.locator('.message--selected')).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Selected messages' })).toHaveCount(0)
  await page.getByLabel('Ask about this conversation').fill('How does the earlier history affect that?')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Review sharing', exact: true })).not.toBeVisible()
  await expect(page.locator('.analysis-answer')).toHaveCount(2)
  await expect(question).toBeFocused()
  expect(sent[1].sourceParts).toEqual(sent[0].sourceParts)
  expect(sent[1].turn.focus).toEqual([])
  expect(sent[1].turn.context).toEqual({ scope: 'discussion' })
  expect(sent[1].history[0].focus).toEqual(sent[0].turn.focus)
  expect(sent[1].history[0].question).toBe('Explain the selected exchange.')
  await page.getByRole('button', { name: 'New discussion', exact: true }).click()
  await expect(page.locator('.analysis-answer')).toHaveCount(0)
  await page.getByLabel('Ask about this conversation').fill('Start separately.')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  await page.getByLabel('Ask about this conversation').press('Enter')
  await expect(page.locator('.analysis-answer')).toHaveCount(1)
  expect(sent).toHaveLength(3)
  expect(sent[2].history).toEqual([])
  expect(sent[2].turn).toMatchObject({ focus: [], context: { scope: 'week' } })
  expect(sent[2].sourceParts.reduce((sum: number, part: string) => sum + Object.keys(JSON.parse(part).messages).length, 0)).toBe(171)
})

test('offers time contexts and persists ChatGPT defaults on the settings page', async ({ page }) => {
  const sent: any[] = []
  await page.route('**/api/chatgpt/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)
    if (action === 'models') return route.fulfill({ json: { models: [{ id: 'synthetic-model', name: 'Synthetic model' }, { id: 'synthetic-alternate', name: 'Synthetic alternate' }] } })
    if (action === 'analyze') {
      sent.push(route.request().postDataJSON())
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"delta","delta":"Synthetic answer."}\n\ndata: {"type":"complete"}\n\n' })
    }
    return route.fulfill({ json: { state: 'connected' } })
  })
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await openConversation(page, 'Weekend plans')
  await page.getByRole('button', { name: 'Ask Echo', exact: true }).click()
  const picker = page.getByRole('button', { name: /^Context:/ })
  await expect(picker).toHaveText('Context: Last week')
  await picker.click()
  await expect(page.getByRole('menuitem')).toHaveText(['Last 24h', 'Last 48h', 'Last week', 'Last month', 'Last year', 'All time'])
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Close ask echo', exact: true }).click()
  await page.locator('.message').filter({ has: page.getByText('Synthetic message 150', { exact: true }) }).click()
  await expect(picker).toHaveText('Context: Surrounding week')
  await picker.click()
  await expect(page.getByRole('menuitem')).toHaveText(['Surrounding 24h', 'Surrounding 48h', 'Surrounding week', 'Surrounding month', 'Surrounding year', 'All time', 'Only selected messages'])
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Ask Echo settings', exact: true }).click()
  await expect(page).toHaveURL(/#\/settings$/)
  await expect(page.getByRole('combobox', { name: 'Default context', exact: true })).toHaveValue('Last week / surrounding week')
  await page.getByRole('combobox', { name: 'Default context', exact: true }).click()
  await page.getByRole('option', { name: 'Last 48h / surrounding 48h', exact: true }).click()
  await page.getByRole('combobox', { name: 'Default model', exact: true }).click()
  await page.getByRole('option', { name: 'Synthetic alternate', exact: true }).click()
  await expect(page.getByRole('button', { name: /^(Save|Load) discussions$/ })).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Default context', exact: true })).toHaveValue('Last 48h / surrounding 48h')
  await expect(page.getByRole('combobox', { name: 'Default model', exact: true })).toHaveValue('Synthetic alternate')
  await page.goBack()
  // Shelf visibility is session-only, so reopen after refreshing the settings route.
  if (!await page.locator('#analysis-shelf').count()) await page.getByRole('button', { name: 'Ask Echo', exact: true }).click()
  await expect(picker).toHaveText('Context: Last 48h')
  await page.getByLabel('Ask about this conversation').fill('Use my defaults.')
  await page.getByLabel('Ask about this conversation').press('Enter')
  await expect(page.locator('.analysis-answer')).toHaveCount(1)
  expect(sent[0]).toMatchObject({ model: 'synthetic-alternate', turn: { context: { scope: '48h' }, focus: [] } })
})

test('defaults to week context, hides the selector after sending, and resets it for a new discussion', async ({ page }) => {
  const sent: any[] = []
  await page.route('**/api/chatgpt/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)
    if (action === 'models') return route.fulfill({ json: { models: [{ id: 'synthetic-model', name: 'Synthetic model' }] } })
    if (action === 'analyze') {
      sent.push(route.request().postDataJSON())
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"delta","delta":"Synthetic answer."}\n\ndata: {"type":"complete"}\n\n' })
    }
    return route.fulfill({ json: { state: 'connected' } })
  })
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await openConversation(page, 'Weekend plans')
  await page.locator('.message').filter({ has: page.getByText('Synthetic message 150', { exact: true }) }).click()
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  const picker = () => page.getByRole('button', { name: /^Context:/ })
  await picker().click()
  await page.getByRole('menuitem', { name: 'Only selected messages', exact: true }).click()
  await page.getByRole('button', { name: 'Remove selected message 1', exact: true }).click()
  await expect(picker()).toHaveText('Context: Last week')
  await expect(page.locator('.conversation-analysis__composer ~ *')).toHaveCount(0)
  const question = page.getByLabel('Ask about this conversation')
  await question.fill('  ')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await question.fill('What happened recently?')
  await question.press('Enter')
  await expect(page.locator('.analysis-answer')).toHaveCount(1)
  expect(sent[0].turn).toMatchObject({ focus: [], images: [], context: { scope: 'week' } })
  await expect(picker()).toHaveCount(0)
  const records = sent[0].sourceParts.flatMap((part: string) => Object.values(JSON.parse(part).messages))
  expect(records).toHaveLength(171)
  expect(records).toContainEqual(expect.objectContaining({ content: 'Synthetic message 151' }))
  expect(records).toContainEqual(expect.objectContaining({ content: 'Synthetic message 150' }))
  await question.fill('Explain further.')
  await question.press('Enter')
  await expect(page.locator('.analysis-answer')).toHaveCount(2)
  expect(sent[1].turn.context).toEqual({ scope: 'discussion' })
  expect(sent[1].sourceParts).toEqual(sent[0].sourceParts)
  await page.getByRole('button', { name: 'New discussion', exact: true }).click()
  await expect(picker()).toHaveText('Context: Last week')
  await question.fill('Summarize the conversation.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('.analysis-answer')).toHaveCount(1)
  expect(sent[2].turn).toMatchObject({ focus: [], context: { scope: 'week' } })
  expect(sent[2].sourceParts.reduce((sum: number, part: string) => sum + Object.keys(JSON.parse(part).messages).length, 0)).toBe(171)
  expect(sent[2].history).toEqual([])
})

test('inspects context from settings and keeps the initial context choice for follow-ups', async ({ page }, testInfo) => {
  const sent: any[] = []
  await page.route('**/api/chatgpt/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)
    if (action === 'models') return route.fulfill({ json: { models: [{ id: 'synthetic-model', name: 'Synthetic model' }] } })
    if (action === 'analyze') {
      sent.push(route.request().postDataJSON())
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"delta","delta":"Synthetic answer."}\n\ndata: {"type":"complete"}\n\n' })
    }
    return route.fulfill({ json: { state: 'connected' } })
  })
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await openConversation(page, 'Weekend plans')
  await page.locator('.message').filter({ has: page.getByText('Synthetic message 150', { exact: true }) }).click()
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  const picker = () => page.getByRole('button', { name: /^Context:/ })
  await expect(picker()).toHaveText('Context: Surrounding week')
  await picker().click()
  await page.getByRole('menuitem', { name: 'Only selected messages', exact: true }).click()
  await page.getByLabel('Ask about this conversation').fill('Translate this message.')
  await expect(page.getByRole('button', { name: 'Inspect context', exact: true })).toHaveCount(0)
  await enableDeveloperMode(page)
  await inspectContext(page)
  const review = page.getByRole('region', { name: 'Context inspector' })
  await expect(review).toContainText('1 source message')
  await expect(review.locator('pre')).toContainText('Synthetic message 150')
  await expect(review.locator('pre')).not.toContainText('Synthetic message 149')
  await expect(review.locator('pre')).not.toContainText('Weekend plans')
  expect(sent).toHaveLength(0)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('.analysis-answer')).toHaveCount(1)
  expect(sent[0].turn.context).toEqual({ scope: 'selected', references: sent[0].turn.focus })
  expect(sent[0].sourceParts.map((part: string) => Object.keys(JSON.parse(part).messages).length)).toEqual([1, 0])
  await expect(page.getByRole('list', { name: 'Selected messages' })).toHaveCount(0)
  await expect(page.locator('.message--selected')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await page.getByLabel('Ask about this conversation').fill('Now translate to French.')
  await inspectContext(page)
  await expect(review).toContainText('discussion')
  await expect(review).toContainText('1 source message')
  expect(sent).toHaveLength(1)
  await page.getByRole('button', { name: 'Close context inspector', exact: true }).click()
  await page.getByLabel('Ask about this conversation').press('Enter')
  await expect(page.getByRole('dialog', { name: 'Review sharing', exact: true })).not.toBeVisible()
  await expect(page.locator('.analysis-answer')).toHaveCount(2)
  expect(sent[1].turn).toMatchObject({ focus: [], context: { scope: 'discussion' }, question: 'Now translate to French.' })
  expect(sent[1].history[0].question).toBe('Translate this message.')
  expect(sent[1].history[0].answer).toBe('Synthetic answer.')
  expect(sent[1].sourceParts).toEqual(sent[0].sourceParts)
  await page.getByRole('button', { name: 'Close ask echo', exact: true }).click()
  await page.locator('.message').filter({ has: page.getByText('Synthetic message 150', { exact: true }) }).click()
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  await expect(picker()).toHaveCount(0)
  await page.getByLabel('Ask about this conversation').fill('Explain the exchange around it.')
  await inspectContext(page)
  await expect(review).toContainText('1 source message')
  await expect(review).toContainText('2 completed discussion turns')
  expect(sent).toHaveLength(2)
  await expect(review.getByRole('checkbox')).toHaveCount(0)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('.analysis-answer')).toHaveCount(3)
  expect(sent[2].history[0].context).toEqual(sent[0].turn.context)
  expect(sent[2].turn.context.scope).toBe('selected')
  await page.screenshot({ path: testInfo.outputPath('synthetic-context-scopes.png') })
  await expect(review).toContainText('Last submitted request')
  await page.getByRole('button', { name: 'Ask Echo settings', exact: true }).click()
  await page.getByText('Developer mode', { exact: true }).click()
  await page.goBack()
  await expect(review).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Inspect context', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'New discussion', exact: true }).click()
  await expect(picker()).toHaveText('Context: Last week')
  await expect(page.locator('.analysis-answer')).toHaveCount(0)
})

test('renders assistant Markdown and keeps validated citations interactive', async ({ page }) => {
  const resourceRequests: string[] = []
  await page.route('https://example.invalid/**', route => { resourceRequests.push(route.request().url()); return route.abort() })
  const answer = [
    '# Synthetic explanation',
    '',
    '- **A statement.**  ',
    '  A second line.  ',
    '  *A reading.* [[p1:m81]]',
    '- Another item.',
    '',
    '---',
    '',
    '| Topic | Detail |',
    '| --- | --- |',
    '| Time | Noon |',
    '',
    '`[[p1:m81]]` and unknown [[p9:m999]].',
    '',
    '```text',
    'A synthetic long code line ' + 'x'.repeat(180),
    '```',
    '',
    '<img src="https://example.invalid/raw.png" onerror="window.unsafe=true">',
    '',
    '![Synthetic image](https://example.invalid/image.png)',
    '',
    '[Unsafe](javascript:alert%281%29) [Safe](https://example.invalid/)',
  ].join('\n')
  await page.route('**/api/chatgpt/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)
    if (action === 'models') return route.fulfill({ json: { models: [{ id: 'synthetic-model', name: 'Synthetic model' }] } })
    if (action === 'analyze') return route.fulfill({ contentType: 'text/event-stream', body:
      [answer.slice(0, 60), answer.slice(60)].map(delta => `data: ${JSON.stringify({ type: 'delta', delta })}\n\n`).join('') + 'data: {"type":"complete"}\n\n' })
    return route.fulfill({ json: { state: 'connected' } })
  })
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await openConversation(page, 'Weekend plans')
  await page.getByRole('button', { name: 'Ask Echo', exact: true }).click()
  await page.getByLabel('Ask about this conversation').fill('Explain the recent messages.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const rendered = page.locator('.analysis-answer')
  await expect(rendered.getByRole('heading', { name: 'Synthetic explanation', level: 3 })).toBeVisible()
  await expect(rendered.locator('ul > li')).toHaveCount(2)
  await expect(rendered.locator('strong')).toHaveText('A statement.')
  await expect(rendered.locator('em')).toHaveText('A reading.')
  await expect(rendered.locator('br')).toHaveCount(2)
  await expect(rendered.locator('hr')).toHaveCount(1)
  await expect(rendered.getByRole('table')).toBeVisible()
  await expect(rendered.locator('code')).toHaveCount(2)
  await expect(rendered.getByRole('button')).toHaveCount(1)
  await expect(rendered.getByRole('link')).toHaveCount(1)
  await expect(rendered.locator('img, script')).toHaveCount(0)
  await expect(rendered.locator('ul')).toHaveCSS('list-style-type', 'disc')
  await expect(rendered.locator('em')).toHaveCSS('font-style', 'italic')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(resourceRequests).toEqual([])
  const citation = rendered.getByRole('button', { name: 'View cited message 161', exact: true })
  await citation.focus()
  await page.keyboard.press('Enter')
  const target = page.locator('.message').filter({ has: page.getByText('Synthetic message 160', { exact: true }) })
  await expect(target).toBeVisible()
  await expect(target).toHaveClass(/message--match/)
})

test('keeps separate shelf sizing, composer space, and discussion state', async ({ page }, testInfo) => {
  const actions: string[] = []
  await page.route('**/api/chatgpt/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)!
    actions.push(action)
    if (action === 'models') return route.fulfill({ json: { models: [{ id: 'gpt-6.1-sol', name: 'Synthetic model' }] } })
    return route.fulfill({ json: { state: 'connected' } })
  })
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await openConversation(page, 'Weekend plans')
  // Media actions and ordinary browser text highlighting do not select messages.
  await page.locator('.message audio').click()
  await expect(page.locator('.message--selected')).toHaveCount(0)
  const original = page.locator('.message').filter({ has: page.getByText('Synthetic message 160', { exact: true }) })
  await original.locator('.message__text').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  })
  await original.dispatchEvent('click')
  await expect(page.locator('.message--selected')).toHaveCount(0)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await original.click()
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  const analysis = page.locator('#analysis-shelf')
  await expect(analysis).toBeVisible()
  await expect(page.getByRole('tab', { name: /Info|Ask Echo/ })).toHaveCount(0)
  await expect(page.getByText('Focus on a passage', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Select messages', exact: true })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Default model', exact: true })).not.toBeVisible()
  if (testInfo.project.name === 'desktop') {
    const width = async (selector: string) => (await page.locator(selector).boundingBox())!.width
    expect(Math.abs(await width('.chat') - await width('#analysis-shelf'))).toBeLessThan(2)
    await openShelf(page)
    expect(await width('#conversation-shelf')).toBe(336)
    await expect(analysis).toHaveCount(0)
    await page.getByRole('button', { name: 'Ask Echo', exact: true }).click()
    await expect(page.locator('#conversation-shelf')).toHaveCount(0)
    expect(Math.abs(await width('.chat') - await width('#analysis-shelf'))).toBeLessThan(2)
    await openShelf(page)
    await closeShelf(page)
    await expect(analysis).toHaveCount(0)
    await expect(page.locator('#conversation-shelf')).toHaveCount(0)
    // A new selection closes Information and opens Ask Echo. Deselecting does neither.
    await openShelf(page)
    await original.click()
    await expect(page.locator('#conversation-shelf')).toBeVisible()
    await expect(analysis).toHaveCount(0)
    await original.click()
    await expect(page.locator('#conversation-shelf')).toHaveCount(0)
    await expect(analysis).toBeVisible()
  } else {
    expect((await analysis.boundingBox())!.width).toBe(page.viewportSize()!.width)
  }
  const question = page.getByLabel('Ask about this conversation')
  await question.fill('A question with enough lines to grow.\n'.repeat(12))
  const textarea = await question.boundingBox()
  const send = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox()
  const padding = await question.evaluate(el => Number.parseFloat(getComputedStyle(el).paddingRight))
  expect(textarea!.height).toBeLessThanOrEqual(200.01)
  expect(send!.x).toBeGreaterThanOrEqual(textarea!.x + textarea!.width - padding)
  expect(send!.y + send!.height).toBeLessThanOrEqual(textarea!.y + textarea!.height)
  await question.fill('Keep this draft.')
  await page.getByRole('button', { name: 'Discussion actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rename discussion', exact: true }).click()
  await page.getByLabel('Discussion name', { exact: true }).fill('A separate reading')
  await page.getByLabel('Discussion name', { exact: true }).press('Enter')
  await page.getByRole('button', { name: 'Close ask echo', exact: true }).click()
  await page.getByRole('button', { name: 'Ask Echo', exact: true }).click()
  await expect(question).toHaveValue('Keep this draft.')
  await expect(page.getByRole('list', { name: 'Selected messages' }).getByRole('listitem')).toHaveCount(1)
  await page.getByRole('button', { name: 'New discussion', exact: true }).click()
  await expect(question).toHaveValue('')
  await page.getByRole('combobox', { name: 'Current discussion', exact: true }).click()
  await page.getByRole('option', { name: 'A separate reading', exact: true }).click()
  await expect(question).toHaveValue('Keep this draft.')
  await page.getByRole('button', { name: 'Ask Echo settings', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Default model', exact: true })).toBeVisible()
  await page.goBack()
  await expect(analysis).toBeVisible()
  await page.getByRole('button', { name: 'Ask Echo settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await page.goBack()
  await expect(analysis).toBeVisible()
  await expect(question).toHaveValue('Keep this draft.')
  expect(actions).not.toContain('analyze')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: `test-results/synthetic-analysis-${testInfo.project.name}.png` })
})

test('inspects actual selected image bytes without sending and explicitly excludes audio', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'echo-analysis-synthetic-'))
  const sent: any[] = []
  try {
    await page.route('**/api/chatgpt/**', route => {
      const action = new URL(route.request().url()).pathname.split('/').at(-1)
      if (action === 'models') return route.fulfill({ json: { models: [{ id: 'gpt-6.1-sol', name: 'Synthetic model' }] } })
      if (action === 'analyze') {
        sent.push(route.request().postDataJSON())
        return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"delta","delta":"A synthetic blue rectangle."}\n\ndata: {"type":"complete"}\n\n' })
      }
      return route.fulfill({ json: { state: 'connected' } })
    })
    await page.goto('/')
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 2048; canvas.height = 1024
      const context = canvas.getContext('2d')!; context.fillStyle = 'blue'; context.fillRect(0, 0, 2048, 1024)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    await writeFile(join(root, 'image.png'), Buffer.from(png, 'base64'))
    await writeFile(join(root, 'message.json'), JSON.stringify({ title: 'Synthetic image discussion', participants: [{ name: 'Example' }], messages: [
      { sender_name: 'Example', content: 'See this synthetic image.', photos: [{ uri: 'image.png' }], audio_files: [{ uri: 'missing-audio.wav' }], timestamp_ms: 1 },
    ] }))
    await page.getByLabel('Choose Instagram export folder').setInputFiles(root)
    await page.getByRole('button', { name: /Synthetic image discussion/ }).click()
    await page.locator('.message__text').click()
    await expect(page.locator('#analysis-shelf')).toBeVisible()
    await enableDeveloperMode(page)
    await inspectContext(page)
    const review = page.getByRole('region', { name: 'Context inspector' })
    await expect(review.getByRole('img', { name: 'Context image 1' })).toBeVisible()
    await expect(review).toContainText('1024 × 512')
    await expect(review).toContainText('Attachment is unavailable in this archive.')
    expect(sent).toHaveLength(0)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.locator('.analysis-answer')).toContainText('synthetic blue rectangle')
    expect(sent[0].turn.images).toHaveLength(1)
    expect(sent[0].turn.images[0]).toMatchObject({ width: 1024, height: 512 })
    expect(sent[0].turn.images[0].dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(sent[0].turn.excluded).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('loads earlier history on scroll, searches from the shelf, and restores reading position', async ({ page }, testInfo) => {
  const errors: string[] = []
  const warnings: string[] = []
  const external: string[] = []
  page.on('pageerror', error => errors.push(error.stack || error.message))
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
  await expect(page.getByText('Attachment unavailable')).toBeVisible()
  await expect(timeline.locator('audio')).toBeVisible()
  await expect(timeline.locator('audio')).toHaveAttribute('controlslist', 'nodownload')
  await expect(timeline.locator('[download]')).toHaveCount(0)
  await expect(page.getByText('<script>window.unsafe = true</script> These are plain words.')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { unsafe?: boolean }).unsafe)).toBeUndefined()
  const anchor = await timeline.evaluate(element => {
    element.scrollTop = 0
    const first = element.querySelector<HTMLElement>('[data-message-id]')!
    const position = { id: first.dataset.messageId, offset: first.getBoundingClientRect().top - element.getBoundingClientRect().top }
    // A media load may arrive before the browser dispatches this scroll.
    element.dispatchEvent(new Event('load'))
    return position
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
  await openSettings(page)
  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-nyx-mode', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-nyx-mode', 'light')
  await page.getByRole('button', { name: 'Back to conversations', exact: true }).click()
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
  await expect(page.getByRole('menuitemradio', { name: 'Inbox', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: 'Message requests', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(folderMenu).toBeFocused()
  await expect(folderMenu).toHaveAttribute('aria-expanded', 'false')
  await showConversationFolder(page, 'A request')
  await expect(page.getByRole('button', { name: /A request/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toHaveCount(0)
  await selectConversationFolder(page, 'Inbox')
  await expect(page.locator('.sidebar').getByRole('textbox')).toHaveCount(0)
  await expect(page.locator('.sidebar__footer')).toHaveCount(0)
  await openConversation(page, 'Weekend plans')
  await page.screenshot({ path: `test-results/synthetic-light-${testInfo.project.name}.png` })
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Back to conversations' }).click()
  await openSettings(page)
  await page.getByRole('button', { name: 'Forget archive' }).click()
  await expect(page.locator('.archive-status')).toHaveText('No archive selected')
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toHaveCount(0)
})

test('does not serve the private data directory', async ({ request }) => {
  const response = await request.get('/data/echo-synthetic-privacy-probe.json')
  expect(response.status()).toBe(403)
})

test('searches both folders through the command palette and restores menu focus on dismissal', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await expect(page.locator('.sidebar__heading > span')).toHaveText('1')
  const menu = page.getByRole('button', { name: 'Conversation folders', exact: true })
  await menu.focus()
  await menu.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: 'Inbox', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('menuitem', { name: 'Search', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  const palette = page.getByRole('dialog', { name: 'Search conversations', exact: true })
  const search = palette.getByRole('combobox', { name: 'Search conversations', exact: true })
  await expect(palette).toBeVisible()
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await expect(search).toBeFocused()
  await search.fill('no matching synthetic participant xyz')
  await expect(palette.getByRole('status')).toContainText('No conversations match')
  await search.fill('Taylor')
  await expect(palette.getByRole('option')).toHaveCount(1)
  await expect(palette.getByRole('option', { name: 'A request', exact: true })).toBeVisible()
  await search.press('Enter')
  await expect(palette).not.toBeVisible()
  await expect(page.getByLabel('Messages', { exact: true })).toContainText('Hello from another conversation')
  await expect(page.locator('#conversation-title')).toBeFocused()
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Back to conversations', exact: true }).click()
  await expect(page.getByRole('button', { name: /A request/ })).toBeVisible()
  await menu.click()
  await expect(page.getByRole('menuitemradio', { name: 'Message requests', exact: true })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('menuitem', { name: 'Search', exact: true }).click()
  await expect(search).toHaveValue('')
  await search.fill('Alex')
  await expect(palette.getByRole('option', { name: 'Weekend plans', exact: true })).toBeVisible()
  await search.press('Escape')
  await expect(palette).not.toBeVisible()
  await expect(menu).toBeFocused()
  await menu.click()
  await page.getByRole('menuitem', { name: 'Search', exact: true }).click()
  await search.fill('Weekend')
  await palette.getByRole('option', { name: 'Weekend plans', exact: true }).click()
  await expect(page.locator('#conversation-title')).toHaveText('Weekend plans')
  await expect(page.locator('#conversation-title')).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
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
  await expect(shelf.getByRole('button', { name: 'Close conversation information' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(shelf).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Conversation information', exact: true })).toBeFocused()
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Back to conversations' }).click()
  await openConversation(page, 'A request')
  await expect(page.locator('.message--self')).toHaveCount(0)
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Back to conversations' }).click()
  await openConversation(page, 'Weekend plans')
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  await page.screenshot({ path: `test-results/synthetic-shelf-${testInfo.project.name}.png` })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('auto-loads verified GIFs, blocks disguised responses and redirects, and never fetches arbitrary URLs', async ({ page, browserName }) => {
  const local = await mkdtemp(join(tmpdir(), 'meta-chat-gifs-'))
  const requests: string[] = []
  page.on('request', request => { if (request.url().startsWith('https:')) requests.push(request.url()) })
  await page.route('https://media.giphy.com/**', async route => {
    const url = route.request().url()
    if (url.includes('/invalid/')) await route.fulfill({ contentType: 'image/gif', body: '<html>not a GIF</html>' })
    else if (url.includes('/redirect/')) {
      // WebKit's interception protocol cannot fulfill a redirect response.
      // Its fetch rejection is equivalent with redirect:error; other engines
      // exercise the actual 302 and the unit contract checks the fetch option.
      if (browserName === 'webkit') await route.abort('failed')
      else await route.fulfill({ status: 302, headers: { location: 'https://untrusted.test/payload.gif' } })
    }
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
  await expect(shelf.locator('.conversation-info__shared').getByRole('tab')).toHaveCount(0)
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
  page.on('pageerror', error => errors.push(error.stack || error.message))
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
    const firstTile = shelf.locator('.conversation-info__media > li').first()
    await firstTile.scrollIntoViewIfNeeded()
    // Lazy decoding can make a later tile's button available first.
    await firstTile.getByRole('button', { name: 'Open photo', exact: true }).click()
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
  await openSettings(page)
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
  await expect(page.getByRole('button', { name: 'Open export folder', exact: true }).filter({ visible: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Forget archive', exact: true })).toHaveCount(0)
  // Forgetting removes only the browser copy: the original fixture can be read again.
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await expect(page.locator('.archive-status')).toHaveText('Saved in this browser')
})

test('restores legacy Blob chunks without rewriting the existing cache format', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'The isolated WebKit context cannot create a legacy Blob-backed cache.')
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Open export folder', exact: true }).filter({ visible: true })).toBeEnabled()
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const source = JSON.stringify({ title: 'Synthetic legacy cache', participants: [{ name: 'Synthetic Self' }], messages: [{ sender_name: 'Synthetic Self', content: 'Generated legacy record', timestamp_ms: 1 }] })
    const bytes = new TextEncoder().encode(source), id = crypto.randomUUID()
    const request = indexedDB.open('meta-chat-archive', 1)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['files', 'metadata'], 'readwrite')
      tx.objectStore('files').put(new Blob([bytes]), [id, 0, 0])
      tx.objectStore('files').put({ path: 'messages/inbox/synthetic/message_1.json', name: 'message_1.json', modified: 0, type: 'application/json', size: bytes.byteLength, chunks: 1 }, [id, 0, -1])
      tx.objectStore('metadata').put({ version: 2, id, count: 1 }, 'archive')
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(new Error('Could not seed synthetic legacy cache')) }
    }
    request.onerror = () => reject(new Error('Could not open synthetic legacy cache'))
  }))
  await page.reload()
  await expect(page.getByRole('button', { name: /Synthetic legacy cache/ })).toBeVisible()
  expect(await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('meta-chat-archive', 1)
    request.onsuccess = () => {
      const db = request.result, read = db.transaction('metadata').objectStore('metadata').get('archive')
      read.onsuccess = () => { db.close(); resolve(read.result.version) }
      read.onerror = () => { db.close(); reject(new Error('Could not inspect synthetic manifest')) }
    }
  }))).toBe(2)
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
  await openSettings(page)
  await page.getByRole('button', { name: 'Forget archive', exact: true }).click()
  await expect(page).toHaveURL(/#\/$/)
  await expect(page.locator('.archive-status')).toHaveText('No archive selected')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Open export folder', exact: true }).filter({ visible: true })).toBeEnabled()
  await expect(page.getByText('Saved archive could not be restored', { exact: false })).toHaveCount(0)
})

test('can read a folder when browser storage is unavailable and reports deletion failures honestly', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.stack || error.message))
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Synthetic denied storage', 'SecurityError') } })
  })
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await expect(page.getByRole('status').filter({ visible: true }).filter({ hasText: 'could not be saved in this browser' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Weekend plans/ })).toBeVisible()
  await openSettings(page)
  await page.getByRole('button', { name: 'Forget archive', exact: true }).click()
  await expect(page.getByRole('status').filter({ visible: true }).filter({ hasText: 'saved archive could not be removed' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Forget archive', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Back to conversations', exact: true }).click()
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
    await openSettings(page)
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
        { sender_name: 'Alex Example', content: 'Alex sent an attachment.', timestamp_ms: Date.UTC(2025, 1, 5), photos: [{ uri: 'photos/pixel.png' }] },
        { sender_name: 'Jamie Sample', content: 'A heart ❤ for you', timestamp_ms: Date.UTC(2025, 1, 6), reactions: [{ actor: 'Alex Example', reaction: '❤' }] },
        { sender_name: 'Alex Example', content: 'Liked a message', timestamp_ms: Date.UTC(2025, 1, 7) },
      ],
    }))
    await page.goto('/')
    await page.getByLabel('Choose Instagram export folder').setInputFiles(extendedFolder)
    await expect(page.locator('.archive-status')).toContainText('Saved in this browser')
    await expect(page.locator('.conversation__preview').first()).toHaveText('A heart ❤️ for you')
    await openConversation(page, 'Weekend plans')
    await page.reload()
    const timeline = page.getByLabel('Messages', { exact: true })
    await expect(timeline.locator('.message')).toHaveCount(80)
    await expect(timeline.getByText('Liked a message', { exact: true })).toHaveCount(0)
    await expect(timeline.getByText('Reacted 😂 to your message', { exact: true })).toHaveCount(0)
    await expect(timeline.getByText('Alex sent an attachment.', { exact: true })).toHaveCount(0)
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
    await expect(timeline.getByText('Alex sent an attachment.', { exact: true })).toHaveCount(1)
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

test('shows local and opt-in remote link previews, preserves fallbacks and shares the cache with the shelf', async ({ page }, testInfo) => {
  const linksFolder = await mkdtemp(join(tmpdir(), 'meta-chat-links-'))
  const thread = join(linksFolder, 'messages/inbox/links')
  await mkdir(join(thread, 'photos'), { recursive: true })
  await writeFile(join(thread, 'photos/cover.gif'), gifBytes)
  await writeFile(join(thread, 'messages.json'), JSON.stringify({ title: 'Synthetic links', participants: [{ name: 'Demo Reader' }], messages: [
    { sender_name: 'Demo Reader', timestamp_ms: 1, share: { link: 'https://example.com/local', title: 'An exported preview', description: 'Available offline', thumbnail: { uri: 'photos/cover.gif' } } },
    { sender_name: 'Demo Reader', timestamp_ms: 2, content: 'https://example.com/article' },
    { sender_name: 'Demo Reader', timestamp_ms: 3, share: { link: 'https://example.com/blocked' } },
  ] }))
  const requests: { url: string; headers: Record<string, string> }[] = []
  await page.route('https://**/*', async route => {
    const request = route.request()
    requests.push({ url: request.url(), headers: request.headers() })
    if (request.url().endsWith('/blocked')) return route.abort('failed')
    if (request.url().endsWith('/cover.gif')) return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'image/gif', body: Buffer.from(gifBytes) })
    if (request.url().endsWith('/article')) return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'text/html', body: '<html><head><meta property="og:title" content="A crawler preview"><meta property="og:description" content="A synthetic description"><meta property="og:image" content="/cover.gif"><script>window.unsafe = true</script></head><body><img src="https://example.org/tracker.png"></body></html>' })
    return route.abort('failed')
  })
  try {
    await page.goto('/')
    await page.getByLabel('Choose Instagram export folder').setInputFiles(linksFolder)
    await page.getByRole('button', { name: /Synthetic links/ }).click()
    const local = page.locator('.chat .link-preview').filter({ hasText: 'An exported preview' })
    await expect(local.locator('img')).toBeVisible()
    await expect(local.getByRole('button')).toHaveCount(0)
    expect(requests).toEqual([])
    const remote = page.locator('.chat .link-preview').filter({ has: page.locator('a[href="https://example.com/article"]') })
    await remote.getByRole('button', { name: 'Load preview from example.com' }).click()
    await expect(remote).toContainText('A crawler preview')
    await expect(remote.locator('img')).toBeVisible()
    await expect(remote.locator('img')).toHaveAttribute('src', /^blob:/)
    await expect(remote).toContainText('A synthetic description')
    expect(requests.map(request => request.url)).toEqual(['https://example.com/article', 'https://example.com/cover.gif'])
    for (const request of requests) {
      expect(request.headers.cookie).toBeUndefined()
      expect(request.headers.referer).toBeUndefined()
    }
    expect(await page.evaluate(() => (window as unknown as { unsafe?: boolean }).unsafe)).toBeUndefined()
    const blocked = page.locator('.chat .link-preview').filter({ has: page.locator('a[href="https://example.com/blocked"]') })
    await blocked.getByRole('button').click()
    await expect(blocked).toContainText('Preview unavailable')
    await expect(blocked.getByRole('link')).toHaveAttribute('href', 'https://example.com/blocked')
    const shelf = await openShelf(page)
    await shelf.getByRole('button', { name: 'Filter shared assets', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Links', exact: true }).click()
    await expect(shelf.locator('.link-preview')).toHaveCount(3)
    await expect(shelf).toContainText('A crawler preview')
    await expect(shelf.locator('.link-preview').filter({ hasText: 'A crawler preview' }).locator('img')).toBeVisible()
    expect(requests).toHaveLength(3)
    await expect(shelf.getByRole('button', { name: 'Go to original message', exact: true })).toHaveCount(3)
    expect(await shelf.locator('.side-shelf__body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/link-previews-${testInfo.project.name}.png` })
    await closeShelf(page)
    await expect(page.locator('.chat__footer')).toContainText('Saved in this browser')
    await page.reload()
    await expect(page.locator('.chat .link-preview').filter({ hasText: 'An exported preview' }).locator('img')).toBeVisible()
    await expect(page.locator('.chat .link-preview').filter({ has: page.locator('a[href="https://example.com/article"]') }).getByRole('button')).toBeVisible()
    expect(requests).toHaveLength(3)
  } finally { await rm(linksFolder, { recursive: true, force: true }) }
})
