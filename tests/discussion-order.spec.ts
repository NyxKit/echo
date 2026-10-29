import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test.use({ timezoneId: 'Europe/Brussels' })

test('sorts discussion options with right-aligned local dates and preserves title-only switching', async ({ page }) => {
  // Generated records and isolated browser state, never a real library or provider.
  const conversationId = randomUUID(), userId = randomUUID(), messageId = randomUUID()
  const saved = [
    { title: 'Synthetic earlier discussion', lastInteractionAt: '2026-10-26T09:00:00.000Z' },
    { title: 'Synthetic latest discussion with a deliberately long title that must truncate while its date stays visible', lastInteractionAt: '2026-10-26T23:30:00.000Z' },
    { title: 'Synthetic undated discussion', lastInteractionAt: null },
  ].map(item => ({ ...item, id: randomUUID(), userId, conversationId, draft: '', draftRevision: 1, scope: 'week', sourceVersion: null, turns: [] }))
  const opened: string[] = []
  let sends = 0
  await page.route(request => request.pathname === '/', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('<head>', '<head><meta name="echo-runtime" content="local-library">') })
  })
  await page.route('**/api/chatgpt/**', route => route.fulfill({ json: { state: 'disconnected' } }))
  await page.route('**/api/library/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/library/v1/', '')
    let value: object = {}
    if (path === 'status') value = { schemaVersion: 9, revision: 1, owner: { userId, label: 'Synthetic Self' } }
    else if (path === 'conversations') value = { items: [{ id: conversationId, userId, title: 'Synthetic conversation', participants: ['Synthetic Self'], pictures: [], category: 'Inbox', messageCount: 1 }] }
    else if (path === 'preferences') value = { values: { activeConversation: conversationId } }
    else if (path.endsWith('/messages')) value = { items: [{ id: messageId, ordinal: 0, sourceJson: '{"sender_name":"Synthetic Self","content":"Synthetic message","timestamp_ms":1}', sourceAssets: [], attachments: [], versionCount: 1, assetConflictCount: 0 }] }
    else if (path.endsWith('/position')) value = { position: null }
    else if (path.endsWith('/discussions')) value = { items: saved }
    else if (path.startsWith('discussions/')) {
      const discussion = saved.find(item => path === `discussions/${item.id}`)
      if (discussion) { opened.push(discussion.id); value = discussion }
      else sends++
    }
    await route.fulfill({ json: { version: 1, ...value } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Ask Echo', exact: true }).click()
  const control = page.getByRole('combobox', { name: 'Current discussion', exact: true })
  await expect(control).toHaveValue(saved[0]!.title)
  await control.click()
  const options = page.getByRole('listbox').filter({ has: page.locator('.conversation-analysis__discussion-option') }).getByRole('option')
  await expect(options.locator('.conversation-analysis__discussion-title')).toHaveText([saved[1]!.title, saved[0]!.title, saved[2]!.title])
  await expect(options.locator('.conversation-analysis__discussion-date')).toHaveText(['27 Oct', '26 Oct'])
  expect(opened).toEqual([saved[0]!.id])
  const layout = await options.evaluateAll(elements => elements.slice(0, 2).map(element => {
    const title = element.querySelector<HTMLElement>('.conversation-analysis__discussion-title')!
    const date = element.querySelector<HTMLElement>('.conversation-analysis__discussion-date')!
    const row = element.querySelector<HTMLElement>('.conversation-analysis__discussion-option')!
    return { titleRight: title.getBoundingClientRect().right, dateLeft: date.getBoundingClientRect().left,
      dateRight: date.getBoundingClientRect().right, rowRight: row.getBoundingClientRect().right,
      truncated: title.scrollWidth > title.clientWidth, dateFits: date.scrollWidth <= date.clientWidth }
  }))
  expect(layout[0]!.truncated).toBe(true)
  for (const row of layout) {
    expect(row.dateLeft).toBeGreaterThan(row.titleRight)
    expect(Math.abs(row.dateRight - row.rowRight)).toBeLessThan(1)
    expect(row.dateFits).toBe(true)
  }
  await options.first().locator('.conversation-analysis__discussion-date').click()
  await expect(control).toHaveValue(saved[1]!.title)
  await expect.poll(() => opened).toEqual([saved[0]!.id, saved[1]!.id])
  await control.click()
  await control.fill('undated')
  await expect(options).toHaveCount(1)
  await expect(options.locator('.conversation-analysis__discussion-date')).toHaveCount(0)
  await control.press('ArrowDown')
  await control.press('Enter')
  await expect(control).toHaveValue(saved[2]!.title)
  expect(sends).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
