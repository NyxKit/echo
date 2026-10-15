import { test, expect, type Page } from '@playwright/test'
import type { ImportChoices, ImportJob, ImportReview } from '../shared/library-types'

// Synthetic responses only; no existing library, browser cache or provider.
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const byId = '11111111-1111-4111-8111-111111111111'
const byHandle = '22222222-2222-4222-8222-222222222222'
const key = '33333333-3333-4333-8333-333333333333'

async function reviewPage(page: Page, handleOnly = false) {
  const candidates: ImportReview['conversations'][number]['candidates'] = [
    { id: byId, title: 'Synthetic ID match', confident: false, match: 'id', identity: { handle: 'synthetic_old', sourceId: '1000001' } },
    { id: byHandle, title: 'Synthetic handle match', confident: false, match: 'handle', identity: { handle: 'synthetic_new', sourceId: '1000002' } },
  ]
  let submitted: ImportChoices | undefined
  let job: ImportJob = { version: 1, id: key, kind: 'zip', state: 'review', bytes: 1, files: 1, cleanupRequired: false,
    review: { version: 1, ready: false, owner: { label: 'Synthetic Self', needsReview: false, candidates: [], existing: { userId: owner, label: 'Synthetic Self' } },
      conversations: [{ key, title: 'Synthetic imported conversation', count: 1, target: null, suggested: handleOnly ? byHandle : byId,
        identity: { handle: 'synthetic_new', sourceId: '1000001' }, candidates: handleOnly ? candidates.slice(1) : candidates, messages: [] }] } }
  await page.route(request => request.pathname === '/', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('<head>', '<head><meta name="echo-runtime" content="local-library">') })
  })
  await page.route('**/api/library/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/library/v1/', '')
    let value: object = {}
    if (path === 'status') value = { schemaVersion: 6, revision: 1, owner: { userId: owner, label: 'Synthetic Self' } }
    else if (path === 'conversations') value = { items: [] }
    else if (path === 'preferences') value = { values: {} }
    else if (path === 'imports') value = { jobs: [job] }
    else if (path === `imports/${key}`) value = job
    else if (path === `imports/${key}/review`) {
      submitted = route.request().postDataJSON()
      job = { ...job, state: 'completed', review: undefined, summary: { userId: owner, revision: 2, additions: 1, matched: 0, changed: 0, unavailableAssets: 0, conversations: 1, unresolved: 0 } }
      value = job
    }
    await route.fulfill({ json: { version: 1, ...value } })
  })
  await page.goto('/#/import')
  return { selected: () => submitted?.conversations?.[key], control: page.getByRole('combobox', { name: 'Synthetic imported conversation: how should this history be kept?', exact: true }) }
}

test('prefills the ID match, keeps the handle alternative and create-new choice, and waits for Apply review', async ({ page }) => {
  const review = await reviewPage(page)
  await expect(review.control).toHaveValue('Match Synthetic ID match (same ID: synthetic_old · 1000001)')
  expect(review.selected()).toBeUndefined()
  await review.control.click()
  const options = page.getByRole('listbox').getByRole('option')
  await expect(options).toHaveText([
    'Match Synthetic ID match (same ID: synthetic_old · 1000001)',
    'Match Synthetic handle match (same handle: synthetic_new · 1000002)',
    'Create a new conversation',
  ])
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(review.control).toHaveValue(/Synthetic ID match/)
  await page.getByRole('button', { name: 'Apply review', exact: true }).click()
  await expect.poll(review.selected).toBe(byId)
  await expect(page.getByText('Import complete', { exact: true })).toBeVisible()
})

test('lets the user override the ID suggestion with the matching handle', async ({ page }) => {
  const review = await reviewPage(page)
  await review.control.click()
  await page.getByRole('listbox').getByRole('option', { name: /Match Synthetic handle match/ }).click()
  await page.getByRole('button', { name: 'Apply review', exact: true }).click()
  await expect.poll(review.selected).toBe(byHandle)
})

test('prefills the handle fallback and lets the user create a separate conversation', async ({ page }) => {
  const review = await reviewPage(page, true)
  await expect(review.control).toHaveValue('Match Synthetic handle match (same handle: synthetic_new · 1000002)')
  expect(review.selected()).toBeUndefined()
  await review.control.click()
  await page.getByRole('listbox').getByRole('option', { name: 'Create a new conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Apply review', exact: true }).click()
  await expect.poll(review.selected).toBe('separate')
})
