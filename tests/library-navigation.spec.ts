import { test, expect, type Page } from '@playwright/test'

// Generated records only. Requests never reach a real library or provider.
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ids = ['00000000-0000-4000-8000-000000000001', '99999999-9999-4999-8999-999999999999']
const conversations = ids.map((id, index) => ({
  id, userId: owner, title: index ? 'January newer year' : 'December older year', participants: ['Synthetic Self'],
  category: 'Inbox', pictures: [], messageCount: 1,
  preview: { text: 'Synthetic navigation record', timestamp: Date.UTC(index ? 2025 : 2024, index ? 0 : 11, 20) },
}))

async function library(page: Page) {
  const mutations: string[] = []
  await page.route(request => request.pathname === '/', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('<head>', '<head><meta name="echo-runtime" content="local-library">') })
  })
  await page.route('**/api/library/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/library/v1/', '')
    if (route.request().method() !== 'GET') mutations.push(path)
    let value: object = {}
    if (path === 'status') value = { schemaVersion: 4, revision: 1, owner: { userId: owner, label: 'Synthetic Self' } }
    else if (path === 'conversations') value = { items: conversations }
    else if (path === 'preferences') value = { values: { activeConversation: ids[1] } }
    else if (path === 'imports') value = { jobs: [{ version: 1, id: owner, state: 'completed', kind: 'zip', bytes: 1, files: 1, cleanupRequired: false,
      summary: { additions: 2, matched: 0, changed: 0, unavailableAssets: 0, conversations: 2 } }] }
    else if (path.endsWith('/messages')) {
      const conversation = conversations.find(item => path.includes(item.id))!
      value = { items: [{ id: owner, ordinal: 0, sourceJson: JSON.stringify({ sender_name: 'Synthetic Self', content: 'Synthetic navigation record', timestamp_ms: conversation.preview.timestamp }), sourceAssets: [], attachments: [], versionCount: 1, assetConflictCount: 0 }] }
    } else if (path.endsWith('/position')) value = { position: null }
    else if (path === 'quit') value = { status: 'stopping' }
    else if (path === 'delete') value = { deleted: true, cleanupRequired: false }
    await route.fulfill({ json: { version: 1, ...value } })
  })
  return mutations
}

test('import completion preserves its route and conversation navigation leaves it', async ({ page }, testInfo) => {
  await library(page)
  await page.goto('/#/import')
  await expect(page.getByRole('status').filter({ hasText: /^Import complete$/ })).toBeVisible()
  await expect(page).toHaveURL(/#\/import$/)
  await expect(page.locator('.conversation__title')).toHaveText(['January newer year', 'December older year'])
  await expect(page.locator('.conversation time').last()).toContainText('2024')
  await expect(page.locator('.sidebar__footer')).toHaveCount(0)
  await expect(page.getByPlaceholder('Find a conversation')).toHaveCount(0)
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Browse conversations', exact: true }).click()
  await page.getByRole('button', { name: /January newer year/ }).click()
  await expect(page.getByRole('heading', { name: 'Import export', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Messages', { exact: true })).toContainText('Synthetic navigation record')
  await page.goBack()
  if (testInfo.project.name === 'mobile') await page.goBack()
  await expect(page).toHaveURL(/#\/import$/)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Import export', exact: true })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /^Import complete$/ })).toBeVisible()
  await expect(page).toHaveURL(/#\/import$/)
})

test('settings routes actions, persists on reload, and keeps delete confirmation explicit', async ({ page }) => {
  const mutations = await library(page)
  await page.goto('/#/settings')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await expect(page.locator('.nyx-action-item__title')).toHaveText(['Appearance', 'Import export', 'Delete library', 'Quit Echo'])
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-nyx-mode', 'light')
  await page.reload()
  await expect(page).toHaveURL(/#\/settings$/)
  await expect(page.locator('html')).toHaveAttribute('data-nyx-mode', 'light')
  await page.getByRole('button', { name: 'Import export', exact: true }).click()
  await expect(page).toHaveURL(/#\/import$/)
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Delete library', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Permanently delete library', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Delete library', exact: true })).toBeFocused()
  expect(mutations).not.toContain('delete')
  await page.getByRole('button', { name: 'Quit Echo', exact: true }).click()
  await expect(page.getByText('Shutdown requested', { exact: true })).toBeVisible()
  expect(mutations.filter(path => path === 'quit')).toHaveLength(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('leaving import cancels a transfer even while its creation is still pending', async ({ page }, testInfo) => {
  const mutations = await library(page)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/library/v1/imports', async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    await gate
    await route.fulfill({ json: { version: 1, id: owner, kind: 'zip', state: 'transferring', bytes: 0, files: 0, cleanupRequired: false } })
  })
  await page.goto('/#/import')
  await expect(page.getByRole('status').filter({ hasText: /^Import complete$/ })).toBeVisible()
  const creating = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/imports'))
  await page.getByLabel('Choose Instagram export ZIP', { exact: true }).setInputFiles({ name: 'generated.zip', mimeType: 'application/zip', buffer: Buffer.from('synthetic transfer, never parsed') })
  await creating
  try {
    if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Back to conversations', exact: true }).click()
    else await page.getByRole('button', { name: /January newer year/ }).click()
    await expect(page.getByRole('heading', { name: 'Import export', exact: true })).toHaveCount(0)
  } finally { release() }
  await expect.poll(() => mutations.filter(path => path === `imports/${owner}/cancel`).length).toBe(1)
  expect(mutations).not.toContain(`imports/${owner}/accept`)
})

test('import displays live matching counters and clears stale progress between phases', async ({ page }) => {
  await library(page)
  let job: object = { version: 1, id: owner, kind: 'zip', state: 'validating', bytes: 1, files: 1, cleanupRequired: false,
    progress: { phase: 'matching', completed: 2, total: 8, current: { unit: 'candidates', completed: 12, total: 40 } } }
  await page.route('**/api/library/v1/imports', route => route.fulfill({ json: { version: 1, jobs: [job] } }))
  await page.route(`**/api/library/v1/imports/${owner}`, route => route.fulfill({ json: job }))
  await page.goto('/#/import')
  await expect(page.getByText('Compared conversations: 2 of 8 · Checking possible matches: 12 of 40', { exact: true })).toBeVisible()
  await expect(page.getByRole('progressbar', { name: 'Checking history' })).toHaveAttribute('aria-valuenow', '25')
  job = { ...job, state: 'committing', progress: undefined }
  await expect(page.getByRole('progressbar', { name: 'Saving to your library' })).not.toHaveAttribute('aria-valuenow')
  await expect(page.getByText(/Compared conversations:/)).toHaveCount(0)
  job = { ...job, progress: { phase: 'committing', completed: 4, total: 8, current: { unit: 'messages', completed: 256, total: 1000 } } }
  await expect(page.getByText('Processed conversations: 4 of 8 · Processing messages: 256 of 1,000', { exact: true })).toBeVisible()
  await expect(page.getByRole('progressbar', { name: 'Saving to your library' })).toHaveAttribute('aria-valuenow', '50')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
