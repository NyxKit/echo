import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// All profiles, exports, library responses and destination pages are synthetic.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const participants = [{ name: 'Synthetic Self' }, { name: 'Synthetic Peer' }]
const message = { sender_name: 'Synthetic Self', content: 'Synthetic profile navigation', timestamp_ms: 1000 }
const profiles = { 'Synthetic Self': 'https://www.instagram.com/synthetic.self/', 'Synthetic Peer': 'https://www.instagram.com/synthetic.peer/' }

for (const runtime of ['viewer', 'library']) {
  test(`${runtime} profile links open Instagram in a new tab without an opener or referrer`, async ({ page, context }) => {
    const directory = await mkdtemp(join(tmpdir(), 'echo-synthetic-profiles-'))
    const navigations: string[] = []
    try {
      await context.route('https://www.instagram.com/**', async route => {
        navigations.push(route.request().url())
        expect((await route.request().allHeaders()).referer).toBeUndefined()
        await route.fulfill({ contentType: 'text/html', body: '<p>Synthetic Instagram destination</p>' })
      })
      await page.route('**/api/chatgpt/**', route => route.fulfill({ json: { state: 'disconnected' } }))
      if (runtime === 'library') {
        await page.route(request => request.pathname === '/', async route => {
          const response = await route.fetch()
          await route.fulfill({ response, body: (await response.text()).replace('<head>', '<head><meta name="echo-runtime" content="local-library">') })
        })
        await page.route('**/api/library/v1/**', route => {
          const path = new URL(route.request().url()).pathname.replace('/api/library/v1/', '')
          let value: object = {}
          if (path === 'status') value = { revision: 1, owner: { userId: ownerId, label: 'Synthetic Self' } }
          else if (path === 'conversations') value = { items: [{ id: conversationId, userId: ownerId, title: 'Synthetic Peer', participants: participants.map(person => person.name), category: 'Inbox', pictures: [], messageCount: 1, preview: { text: message.content, timestamp: 1000 } }] }
          else if (path === 'preferences') value = { values: {} }
          else if (path.endsWith('/messages')) value = { items: [{ id: ownerId, ordinal: 0, sourceJson: JSON.stringify(message), sourceAssets: [], attachments: [], versionCount: 1, assetConflictCount: 0 }] }
          else if (path.endsWith('/position')) value = { position: null }
          else if (path.endsWith('/profiles')) value = { profiles }
          else if (path.endsWith('/context')) value = { conversationId, markdown: '', revision: 0, inherited: [], inheritance: 'none' }
          return route.fulfill({ json: { version: 1, ...value } })
        })
      } else {
        const conversation = join(directory, 'messages/inbox/synthetic.peer_123')
        await mkdir(conversation, { recursive: true })
        await writeFile(join(conversation, 'message_1.json'), JSON.stringify({ title: 'Synthetic Peer', owner: { name: 'Synthetic Self', username: 'synthetic.self' }, participants, messages: [message] }))
      }
      await page.goto('/')
      if (runtime === 'viewer') await page.getByLabel('Choose Instagram export folder').setInputFiles(directory)
      await page.getByRole('button', { name: /Synthetic Peer/ }).click()
      await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
      const shelf = page.locator('#conversation-shelf')
      const peerLinks = shelf.getByRole('link', { name: 'Open Synthetic Peer on Instagram (opens in a new tab)', exact: true })
      await expect(peerLinks).toHaveCount(2)
      await expect(shelf.getByRole('link', { name: 'Open Synthetic Self on Instagram (opens in a new tab)', exact: true })).toHaveAttribute('href', profiles['Synthetic Self'])
      for (const link of await peerLinks.all()) {
        await expect(link).toHaveAttribute('href', profiles['Synthetic Peer'])
        await expect(link).toHaveAttribute('target', '_blank')
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      }
      expect(navigations).toEqual([])
      const originalUrl = page.url()
      const opened = context.waitForEvent('page')
      await peerLinks.first().click()
      const popup = await opened
      await popup.waitForLoadState()
      await expect(popup).toHaveURL(profiles['Synthetic Peer'])
      expect(await popup.evaluate(() => window.opener)).toBeNull()
      expect(await popup.evaluate(() => document.referrer)).toBe('')
      await popup.close()
      await expect(page).toHaveURL(originalUrl)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}

test('serves the favicon with the same paths as the sidebar icon', async ({ page }) => {
  await page.goto('/')
  const href = await page.locator('link[rel="icon"]').getAttribute('href')
  expect(href).toBeTruthy()
  const response = await page.request.get(new URL(href!, page.url()).href)
  expect(response.ok()).toBe(true)
  expect(response.headers()['content-type']).toContain('image/svg+xml')
  const paths = await page.evaluate(svg => [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('path')].map(path => path.getAttribute('d')), await response.text())
  expect(paths).toEqual(await page.locator('.sidebar__logo svg path').evaluateAll(paths => paths.map(path => path.getAttribute('d'))))
})
