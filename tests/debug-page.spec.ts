import { test, expect } from '@playwright/test'

// Isolated browser storage and synthetic responses only.
test('debug page backfills only after a click and shows saved progress', async ({ page }) => {
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']
  const sent: unknown[] = []
  let candidateRequests = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(request => request.pathname === '/', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('<head>', '<head><meta name="echo-runtime" content="local-library">') })
  })
  await page.route('**/api/chatgpt/**', route => route.fulfill({ json: route.request().url().endsWith('/status')
    ? { state: 'connected' } : { models: [{ id: 'gpt-6.1-sol', name: 'Synthetic model' }] } }))
  await page.route('**/api/library/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/library/v1/', '')
    let value: object = {}
    if (path === 'status') value = { schemaVersion: 4, revision: 1, owner: null }
    else if (path === 'debug/discussion-subjects') { candidateRequests++; value = { items: candidateRequests === 1 ? ids : [], after: null } }
    else if (path.endsWith('/subject')) {
      sent.push(route.request().postDataJSON())
      if (sent.length === 1) await gate
      value = { updated: sent.length === 1 }
    }
    await route.fulfill({ json: { version: 1, ...value } })
  })
  await page.goto('/#/debug')
  await expect(page.getByRole('heading', { name: 'Debug', exact: true })).toBeVisible()
  const generate = page.getByRole('button', { name: 'Generate missing subjects' })
  await expect(generate).toBeEnabled()
  expect(candidateRequests).toBe(0); expect(sent).toEqual([])
  await expect(page.locator('.debug-page .nyx-action-item__description p')).toHaveText([
    'Generate subjects for saved Ask Echo discussions that still use their first prompt as a title. Custom titles are kept.',
    'Keep this page open while the update runs; leaving stops it.',
  ])
  await expect(page.locator('.debug-page').getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0)
  await generate.click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(generate).toBeDisabled()
  release()
  await expect(page.getByRole('status').filter({ hasText: 'Finished.' })).toContainText('2 of 2 processed. 1 updated, 1 skipped because they changed.')
  expect(sent).toEqual([{ model: 'gpt-6.1-sol' }, { model: 'gpt-6.1-sol' }])
  await generate.click()
  await expect(page.getByText('No discussions need a subject.', { exact: true })).toBeVisible()
  expect(sent).toHaveLength(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Back to conversations', exact: true }).click()
  await expect(page).toHaveURL(/#\/$/)
})
