import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// All browser state and source records are generated for these tests.
let folder: string
test.beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'echo-synthetic-prompt-assets-'))
  const day = 86_400_000
  for (const [key, title, category, timestamps] of [
    ['primary', 'Synthetic primary', 'inbox', [100 * day]],
    ['other', 'Synthetic source', 'message_requests', [0, 20 * day, 30 * day]],
    ['third', 'Synthetic third', 'inbox', [10 * day]],
    ['undated', 'Synthetic undated', 'inbox', [null]],
  ] as const) {
    const directory = join(folder, 'messages', category, key)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'message_1.json'), JSON.stringify({ title, participants: [{ name: 'Synthetic Self' }, { name: `Synthetic ${key} peer` }],
      messages: timestamps.map((timestamp_ms, index) => ({ sender_name: 'Synthetic Self', content: `Synthetic ${key} message ${index}`, timestamp_ms })) }))
  }
})
test.afterAll(async () => { await rm(folder, { recursive: true, force: true }) })

async function fixture(page: Page) {
  const requests: any[] = [], subjects: any[] = []
  let fail = false
  await page.route('**/api/chatgpt/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)
    if (action === 'models') return route.fulfill({ json: { models: [{ id: 'synthetic-model', name: 'Synthetic model' }] } })
    if (action === 'subject') { subjects.push(route.request().postDataJSON()); return route.fulfill({ json: { title: 'Synthetic comparison' } }) }
    if (action === 'analyze') {
      const payload = route.request().postDataJSON()
      requests.push(payload)
      if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: 'Synthetic send failure' } }) }
      const asset = payload.turn.assets?.[0] ?? payload.history[0]?.assets?.[0]
      const reference = asset ? Object.keys(asset.referenceMap)[0] : undefined
      const answer = asset ? `Synthetic answer [[a${asset.id}:${reference}]]` : 'Synthetic answer'
      return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'delta', delta: answer })}\n\ndata: {"type":"complete"}\n\n` })
    }
    return route.fulfill({ json: { state: 'connected' } })
  })
  await page.goto('/')
  await page.getByLabel('Choose Instagram export folder').setInputFiles(folder)
  await page.getByRole('button', { name: /Synthetic primary/ }).click()
  await page.getByRole('button', { name: 'Ask Echo', exact: true }).click()
  return { requests, subjects, question: page.getByLabel('Ask about this conversation', { exact: true }), failNext() { fail = true } }
}

async function openPicker(page: Page) {
  await page.getByRole('button', { name: 'Add asset', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add conversation', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Add conversation context', exact: true })
  await expect(modal).toBeVisible()
  return modal
}

async function add(page: Page, name = 'Synthetic source', scope?: string) {
  const modal = await openPicker(page)
  const conversation = modal.getByRole('combobox', { name: 'Search conversations to attach', exact: true })
  await conversation.fill(name)
  await modal.getByRole('option', { name, exact: true }).click()
  if (scope) {
    await modal.getByRole('combobox', { name: 'Attached context window', exact: true }).click()
    await modal.getByRole('option', { name: scope, exact: true }).click()
  }
  await modal.getByRole('button', { name: 'Add conversation', exact: true }).click()
  await expect(modal).not.toBeVisible()
}

test('adds independent context, preserves drafts, and keeps picker keyboard actions local', async ({ page }) => {
  const app = await fixture(page)
  await app.question.fill('Compare the synthetic conversations')
  const modal = await openPicker(page)
  const select = modal.getByRole('combobox', { name: 'Search conversations to attach', exact: true })
  await expect(select).toBeFocused()
  const rows = modal.getByRole('listbox', { name: 'Search conversations to attach', exact: true }).getByRole('option')
  await expect(rows).toHaveText([/Synthetic primary/, /Synthetic source/, /Synthetic third/, /Synthetic undated/])
  await expect(rows.first()).toBeDisabled()
  await expect(rows.first()).toContainText('Current conversation')
  await select.fill('nothing matches')
  await expect(modal.getByRole('status')).toHaveText('No matching conversations.')
  await expect(rows).toHaveCount(0)
  await select.press('Escape')
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add asset', exact: true })).toBeFocused()
  await expect(modal).not.toBeVisible()
  expect(app.requests).toHaveLength(0)
  await add(page)
  await expect(app.question).toBeFocused()
  await expect(app.question).toHaveValue('Compare the synthetic conversations')
  const chips = page.getByRole('list', { name: 'Attached conversations', exact: true })
  await expect(chips.getByRole('listitem')).toHaveCount(1)
  await chips.getByRole('button', { name: 'Context for Synthetic source: Last week', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Last 24h', exact: true }).click()
  await add(page, 'Synthetic third', 'All time')
  await expect(chips.getByRole('listitem')).toHaveCount(2)
  await openPicker(page)
  await expect(modal.getByRole('option', { name: 'Synthetic source', exact: true })).toBeDisabled()
  await expect(modal.getByRole('option', { name: 'Synthetic third', exact: true })).toContainText('Already attached')
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'New discussion', exact: true }).click()
  await expect(chips).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Current discussion', exact: true }).click()
  await page.getByRole('option', { name: 'New discussion', exact: true }).first().click()
  await expect(chips.getByRole('listitem')).toHaveCount(2)
  await page.getByRole('button', { name: 'Remove attached conversation Synthetic third', exact: true }).click()
  await expect(chips.getByRole('listitem')).toHaveCount(1)
  expect(app.requests).toHaveLength(0)
  expect(app.subjects).toHaveLength(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('opens the attachment menu upward, keeps upcoming options disabled, and supports keyboard modal selection', async ({ page }) => {
  const app = await fixture(page)
  await app.question.fill('Keep this synthetic draft')
  const plus = page.getByRole('button', { name: 'Add asset', exact: true })
  await plus.click()
  const menu = page.getByRole('menu', { name: 'Add asset', exact: true })
  await expect(menu).toHaveAttribute('data-position', 'top-left')
  await expect(menu.getByRole('menuitem', { name: 'Upload file (coming soon)', exact: true })).toBeDisabled()
  await expect(menu.getByRole('menuitem', { name: 'Add link (coming soon)', exact: true })).toBeDisabled()
  const position = await menu.boundingBox(), button = await plus.boundingBox()
  expect(position!.y + position!.height).toBeLessThanOrEqual(button!.y)
  await plus.press('Escape')
  await expect(plus).toHaveAttribute('aria-expanded', 'false')
  await expect(plus).toBeFocused()
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  await plus.press('ArrowUp')
  const action = menu.getByRole('menuitem', { name: 'Add conversation', exact: true })
  await expect(action).toBeFocused()
  await action.press('ArrowDown')
  await expect(action).toBeFocused()
  await action.press('Enter')
  const modal = page.getByRole('dialog', { name: 'Add conversation context', exact: true })
  const search = modal.getByRole('combobox', { name: 'Search conversations to attach', exact: true })
  await expect(search).toBeFocused()
  await search.fill('other peer')
  await expect(modal.getByRole('listbox', { name: 'Search conversations to attach', exact: true }).getByRole('option')).toHaveText([/Synthetic source/])
  await search.press('ArrowDown')
  await search.press('Enter')
  await expect(modal).toBeVisible()
  await expect(modal.getByText('Selected: Synthetic source', { exact: true })).toBeVisible()
  expect(app.requests).toHaveLength(0)
  await modal.getByRole('button', { name: 'Add conversation', exact: true }).click()
  await expect(app.question).toBeFocused()
  await expect(app.question).toHaveValue('Keep this synthetic draft')
  await expect(page.getByRole('list', { name: 'Attached conversations', exact: true })).toContainText('Synthetic source')
  await openPicker(page)
  const window = modal.getByRole('combobox', { name: 'Attached context window', exact: true })
  await window.click()
  await expect(window).toHaveAttribute('aria-expanded', 'true')
  await window.press('Escape')
  await expect(window).toHaveAttribute('aria-expanded', 'false')
  await expect(modal).toBeVisible()
  await window.press('Escape')
  await expect(modal).not.toBeVisible()
  await expect(plus).toBeFocused()
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  await openPicker(page)
  await modal.getByRole('combobox', { name: 'Search conversations to attach', exact: true }).evaluate(element => (element as HTMLInputElement).blur())
  await page.keyboard.press('Escape')
  await expect(modal).not.toBeVisible()
  await expect(plus).toBeFocused()
  await expect(page.locator('#analysis-shelf')).toBeVisible()
  expect(app.requests).toHaveLength(0)
  expect(app.subjects).toHaveLength(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('sends exact snapshots, retains earlier assets on follow-ups, and navigates attributed citations', async ({ page }) => {
  const app = await fixture(page)
  await add(page)
  await app.question.fill('Did I omit anything?')
  await app.question.press('Enter')
  await expect(page.locator('.analysis-answer')).toHaveCount(1)
  await expect(page.getByRole('list', { name: 'Attached conversations', exact: true })).toHaveCount(0)
  const first = app.requests[0], asset = first.turn.assets[0]
  expect(first.turn.context.scope).toBe('week')
  expect(first.sourceParts.join('')).not.toContain('Synthetic other message')
  expect(asset.sourceParts.flatMap((part: string) => Object.values(JSON.parse(part).messages))).toEqual([expect.objectContaining({ content: 'Synthetic other message 2' })])
  await expect(page.getByRole('list', { name: 'Shared conversation context', exact: true })).toContainText('Synthetic source · Last week')
  await app.question.fill('Explain more without another attachment')
  await app.question.press('Enter')
  await expect(page.locator('.analysis-answer')).toHaveCount(2)
  expect(app.requests[1].history[0].assets).toEqual(first.turn.assets)
  expect(app.requests[1].turn.assets).toEqual([])
  expect(app.requests[1].turn.context).toEqual({ scope: 'discussion' })
  await add(page, 'Synthetic third', 'All time')
  await app.question.fill('Compare this source too')
  await app.question.press('Enter')
  await expect(page.locator('.analysis-answer')).toHaveCount(3)
  expect(app.requests[2].turn.context).toEqual({ scope: 'discussion' })
  expect(app.requests[2].turn.assets[0].scope).toBe('full')
  await expect.poll(() => app.subjects.length).toBe(1)
  expect(app.subjects[0]).toEqual({ model: 'synthetic-model', question: 'Did I omit anything?' })
  await page.getByRole('button', { name: /View cited message in Synthetic source/ }).first().click()
  await expect(page.getByRole('heading', { name: 'Synthetic source', exact: true })).toBeVisible()
  await expect(page.locator('.message--match')).toContainText('Synthetic other message 2')
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Synthetic primary', exact: true })).toBeVisible()
  await page.goForward()
  await expect(page.getByRole('heading', { name: 'Synthetic source', exact: true })).toBeVisible()
  await expect(page.locator('.message--match')).toHaveCount(0)
})

test('retains attachments on failure, restores retry choices, and requires All time for undated sources', async ({ page }) => {
  const app = await fixture(page)
  await add(page, 'Synthetic undated')
  await app.question.fill('Compare synthetic evidence')
  await app.question.press('Enter')
  await expect(page.getByRole('alert')).toContainText('no usable timestamps')
  await expect(page.getByRole('list', { name: 'Attached conversations', exact: true })).toContainText('Synthetic undated')
  expect(app.requests).toHaveLength(0)
  await page.getByRole('button', { name: 'Context for Synthetic undated: Last week', exact: true }).click()
  await page.getByRole('menuitem', { name: 'All time', exact: true }).click()
  app.failNext()
  await app.question.press('Enter')
  await expect(page.getByText('Synthetic send failure', { exact: true })).toBeVisible()
  await expect(app.question).toHaveValue('Compare synthetic evidence')
  await expect(page.getByRole('list', { name: 'Attached conversations', exact: true })).toContainText('Synthetic undated')
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.locator('.analysis-answer')).toHaveCount(1)
  expect(app.requests).toHaveLength(2)
  expect(app.requests[1].turn.assets[0].scope).toBe('full')
  expect(app.requests[1].turn.assets[0].id).not.toBe(app.requests[0].turn.assets[0].id)
  await expect(page.getByRole('list', { name: 'Attached conversations', exact: true })).toHaveCount(0)
})
