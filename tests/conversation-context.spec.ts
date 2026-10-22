import { test, expect, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'

// All state and responses are synthetic, with a fresh browser context per test.
async function fixture(page: Page, initial = '**Synthetic** background', groupStart = false) {
  const ids = [randomUUID(), randomUUID()], userId = randomUUID(), messageId = randomUUID()
  const notes = new Map<string, { markdown: string; revision: number }>(ids.map(id => [id, { markdown: id === ids[0] ? initial : 'Independent context', revision: 1 }]))
  const routeId = (id: string) => createHash('sha256').update(`meta-chat-conversation:${id}`).digest('hex')
  let writes = 0, preparations = 0, sends = 0, fail = false, conflict = false
  let delay: Promise<void> | undefined
  const discussionId = randomUUID()
  let discussion: any
  let prepared: any
  await page.route(request => request.pathname === '/', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('<head>', '<head><meta name="echo-runtime" content="local-library">') })
  })
  await page.route('**/api/chatgpt/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/models')
    ? { models: [{ id: 'synthetic-model', name: 'Synthetic model' }] } : { state: 'connected' } }))
  await page.route('**/api/library/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/library/v1/', ''), method = route.request().method()
    let value: any = {}
    if (path === 'status') value = { schemaVersion: 7, revision: 1, owner: { userId, label: 'Synthetic Self' } }
    else if (path === 'conversations') value = { items: ids.map(id => ({ id, userId, title: 'Synthetic conversation', participants: groupStart && id === ids[0] ? ['Synthetic Self', 'Synthetic Peer', 'Synthetic Third'] : ['Synthetic Self', 'Synthetic Peer'], pictures: [], category: 'Inbox', messageCount: 1, preview: { text: 'Synthetic message', timestamp: 1 } })) }
    else if (path === 'preferences') value = { values: { activeConversation: ids[0] } }
    else if (path.endsWith('/messages')) value = { items: [{ id: messageId, ordinal: 0, sourceJson: '{"sender_name":"Synthetic Self","content":"Synthetic message","timestamp_ms":1}', sourceAssets: [], attachments: [], versionCount: 1, assetConflictCount: 0 }] }
    else if (path.endsWith('/position')) value = { position: null }
    else if (path.endsWith('/context')) {
      const id = path.split('/')[1]!, note = notes.get(id)!
      if (method === 'PUT') {
        writes++
        const input = route.request().postDataJSON()
        if (delay) await delay
        if (fail) { fail = false; await route.fulfill({ status: 503, json: { code: 'unavailable' } }); return }
        if (conflict) { conflict = false; note.markdown = 'Changed in another tab'; note.revision++ }
        if (input.revision !== note.revision) { await route.fulfill({ status: 409, json: { code: 'library_note_conflict' } }); return }
        Object.assign(note, { markdown: input.markdown, revision: note.revision + 1 })
      }
      value = { ...note, userId, conversationId: id,
        ...(groupStart && id === ids[0] ? { inherited: [{ conversationId: ids[1], title: 'Synthetic conversation', participant: 'Synthetic Peer' }], relatedConversationIds: [ids[1]], inheritance: 'resolved' }
          : { inherited: [], relatedConversationIds: [], inheritance: 'none' }) }
    } else if (path.endsWith('/discussions')) value = { items: discussion ? [discussion] : [] }
    else if (path.startsWith('discussions/') && !path.endsWith('/prepare') && !path.endsWith('/turns') && !path.endsWith('/context-status')) {
      if (method === 'PUT') {
        const input = route.request().postDataJSON()
        discussion = { ...input, id: path.split('/')[1], userId, draftRevision: (discussion?.draftRevision ?? 0) + 1, turns: [] }
      }
      value = discussion ?? { id: discussionId }
    } else if (path.endsWith('/context-status')) value = { status: 'initial', scope: 'week', generation: 'a'.repeat(64) }
    else if (path.endsWith('/prepare')) {
      preparations++
      const input = route.request().postDataJSON(), note = notes.get(ids[0]!)!
      prepared = { requestId: randomUUID(), model: input.model, sourceVersion: 'a'.repeat(64), contextVersion: 'b'.repeat(64),
        sourceParts: ['{"messages":{"0":{"sender_name":"Synthetic Self","content":"Synthetic message","timestamp_ms":1}}}'], history: [],
        turn: { question: input.question, focus: [], context: { scope: 'week', references: ['p1:m1'] }, images: [], excluded: [],
          background: { version: 1, binding: 'c'.repeat(64), notes: [{ userId, conversationId: ids[0], revision: note.revision, kind: 'conversation', label: 'Synthetic conversation', markdown: note.markdown }] } } }
      value = { payload: prepared, revision: 1, referenceMap: { 'p1:m1': messageId } }
    } else if (path.endsWith('/turns')) {
      sends++
      await route.fulfill({ status: 409, json: { code: 'library_context_changed' } }); return
    }
    await route.fulfill({ json: { version: 1, ...value } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Conversation context', exact: true })
  await expect(editor).toBeVisible()
  return { ids, notes, editor, get writes() { return writes }, get preparations() { return preparations }, get sends() { return sends }, get prepared() { return prepared },
    failNext() { fail = true }, conflictNext() { conflict = true }, delay(value?: Promise<void>) { delay = value },
    async navigate(id: string) { await page.evaluate(hash => { location.hash = hash }, `/conversation/${routeId(id)}`) } }
}

test('formats with the nyx-kit editor, preserves conversation drafts across navigation and reloads committed notes', async ({ page }, testInfo) => {
  const app = await fixture(page, '')
  await app.editor.fill('Formatted synthetic context')
  if (testInfo.project.name === 'mobile') {
    await app.editor.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element)
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await page.locator('.nyx-editor__bubble').getByRole('button', { name: 'Bold', exact: true }).click()
  } else {
    await app.editor.press('ControlOrMeta+a'); await app.editor.press('ControlOrMeta+b')
  }
  await expect(app.editor.locator('strong')).toHaveText('Formatted synthetic context')
  await expect.poll(() => app.notes.get(app.ids[0]!)!.markdown).toBe('**Formatted synthetic context**')
  let release!: () => void
  app.delay(new Promise<void>(resolve => { release = resolve }))
  await app.editor.fill('First conversation draft')
  await page.getByRole('button', { name: 'Conversation context', exact: true }).click()
  await page.getByRole('button', { name: 'Conversation context', exact: true }).click()
  await expect(app.editor).toHaveText('First conversation draft')
  await app.navigate(app.ids[1]!)
  await expect(app.editor).toHaveText('Independent context')
  release(); app.delay()
  await app.editor.fill('Second conversation draft')
  await page.getByRole('button', { name: 'Close conversation information' }).click()
  await expect.poll(() => app.notes.get(app.ids[1]!)!.markdown).toBe('Second conversation draft')
  await app.navigate(app.ids[0]!)
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  await expect(app.editor).toHaveText('First conversation draft')
  await page.reload()
  await expect(app.editor).toHaveText('First conversation draft')
  expect(app.preparations).toBe(0); expect(app.sends).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('retains failed and conflicting drafts, recovers explicitly, and prepares saved context only on Send', async ({ page }) => {
  const app = await fixture(page, '')
  app.failNext(); await app.editor.fill('Synthetic draft to retain')
  await page.getByText('Background supplied by you.', { exact: false }).click()
  await expect(page.getByRole('alert')).toContainText('could not be saved')
  await expect(app.editor).toHaveText('Synthetic draft to retain')
  await page.getByRole('button', { name: 'Retry context', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  app.conflictNext(); await app.editor.fill('My synthetic local version')
  await page.getByText('Background supplied by you.', { exact: false }).click()
  await expect(page.getByRole('alert')).toContainText('another tab')
  await expect(app.editor).toHaveText('My synthetic local version')
  await page.getByRole('button', { name: 'Keep my draft', exact: true }).click()
  await expect.poll(() => app.notes.get(app.ids[0]!)!.markdown).toBe('My synthetic local version')
  expect(app.preparations).toBe(0); expect(app.sends).toBe(0)
  await page.getByRole('button', { name: 'Close conversation information' }).click()
  await page.getByRole('button', { name: 'Ask Echo', exact: true }).click()
  const question = page.getByLabel('Ask about this conversation', { exact: true })
  await question.fill('Synthetic question')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('source or discussion changed')
  await expect(question).toHaveValue('Synthetic question')
  expect(app.prepared.turn.background.notes[0].markdown).toBe('My synthetic local version')
  expect(app.preparations).toBe(1); expect(app.sends).toBe(1)
})

test('keeps raw HTML and images inert, pastes as text, and prevents note links from navigating', async ({ page }) => {
  const requests: string[] = []
  page.on('request', request => { if (request.url().includes('synthetic.invalid')) requests.push(request.url()) })
  const app = await fixture(page, '<img src="https://synthetic.invalid/image" onerror="window.syntheticExecuted=true">\n\n![Synthetic image](https://synthetic.invalid/image)\n\n[Safe link](https://synthetic.invalid/link)\n\n[Unsafe link](javascript:alert(1))\n\n`<synthetic-code>`\n\n```html\n<img src="https://synthetic.invalid/code">\n```\n\n> ```\n<img src="https://synthetic.invalid/outside-quote">\n> ```')
  await expect(app.editor.locator('img,script,iframe')).toHaveCount(0)
  await expect(app.editor).toContainText('<img src=')
  await expect(app.editor.locator('code').first()).toHaveText('<synthetic-code>')
  const link = app.editor.getByText('Safe link', { exact: true })
  const url = page.url(); await link.click(); expect(page.url()).toBe(url)
  await app.editor.focus()
  await app.editor.evaluate(element => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/html', '<img src="https://synthetic.invalid/pasted" onerror="window.syntheticExecuted=true"><b>Synthetic paste</b>')
    clipboardData.setData('text/plain', '<img src="https://synthetic.invalid/pasted">Synthetic paste')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  })
  await expect(app.editor.locator('img,script,iframe')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).syntheticExecuted)).toBeUndefined()
  expect(requests).toEqual([])
  expect(app.preparations).toBe(0); expect(app.sends).toBe(0)
})

test('edits group context separately and links to individual context with one editor at a time', async ({ page }) => {
  const app = await fixture(page, '', true)
  await expect(page.locator('.conversation-context [contenteditable="true"]')).toHaveCount(1)
  await expect(page.getByText('Individual context also included:', { exact: true })).toBeVisible()
  await app.editor.fill('Synthetic group background')
  await page.getByRole('link', { name: 'Synthetic Peer · Synthetic conversation', exact: true }).click()
  await expect(app.editor).toHaveText('Independent context')
  await expect(page.locator('.conversation-context [contenteditable="true"]')).toHaveCount(1)
  await expect.poll(() => app.notes.get(app.ids[0]!)!.markdown).toBe('Synthetic group background')
  await expect(page.getByText('Individual context also included:', { exact: true })).toHaveCount(0)
  expect(app.preparations).toBe(0); expect(app.sends).toBe(0)
})
