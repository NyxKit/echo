import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, access, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, firefox, webkit, expect } from '@playwright/test'
import { startApplication } from '../server/application.mjs'
import { openLibrary } from '../server/library/client.mjs'
import { newInstance, publishInstance } from '../server/runtime-state.mjs'
import { launch } from '../server/launcher.mjs'
import { syntheticZip } from '../tests/helpers/synthetic-zip.mjs'

// Deliberately use a new browser profile and disposable lifecycle/library roots.
// Never attach this check to an existing Echo server or a real browser profile.
const directory = await mkdtemp(join(tmpdir(), 'echo-synthetic-browser-'))
const runtime = join(directory, 'runtime')
const root = fileURLToPath(new URL('../dist', import.meta.url))
let browser, app, standalone, library
const engineName = process.env.ECHO_BROWSER ?? 'chromium'
const engine = { chromium, chrome: chromium, msedge: chromium, firefox, webkit }[engineName]
if (!engine) throw new Error('Unknown browser engine')
let dispatches = 0, finishResponse
const responseGate = new Promise(resolve => { finishResponse = resolve })
try {
  await mkdir(runtime, { mode: 0o700 })
  library = await openLibrary(join(directory, 'library'))
  const state = newInstance(0)
  let quit = false
  app = await startApplication({ root, state, library, browserDirectory: runtime,
    createService: () => ({ close: async () => {}, handle: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url.endsWith('/models')
        ? { models: [{ id: 'synthetic-model', name: 'Synthetic model' }] } : { state: 'connected' }))
    }, prepareJob: async () => ({ providerAccount: 'a'.repeat(64), run: async ({ onEvent }) => {
      dispatches++; await onEvent({ type: 'delta', delta: 'Synthetic partial ' }); await responseGate
      await onEvent({ type: 'delta', delta: 'answer [[p1:m1]]' }); await onEvent({ type: 'complete' })
    } }) }), onQuit: () => { quit = true } })
  await publishInstance(runtime, state)
  browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] } : {}),
    ...(['chrome','msedge'].includes(engineName) ? process.env.ECHO_BROWSER_EXECUTABLE
      ? { executablePath: process.env.ECHO_BROWSER_EXECUTABLE } : { channel: engineName } : {}) })
  const context = await browser.newContext()
  context.setDefaultTimeout(10_000)
  const nonlocal = []
  context.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== app.origin) nonlocal.push(true)
  })
  let page = await context.newPage()
  page.setDefaultTimeout(10_000)
  await page.goto(app.origin)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByText('Connect this browser', { exact: true }).waitFor()
  let handoff
  await launch({ directory: runtime, root, browser: async target => {
    handoff = target
    assert.equal(new URL(target).protocol, 'file:')
    await page.goto(target)
  } })
  await page.waitForURL(url => url.origin === app.origin && url.pathname === '/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByText('Echo is running', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.cookie.includes('echo_library_')), false)
  await assert.rejects(access(fileURLToPath(handoff)))
  await page.getByRole('button', { name: 'Import export', exact: true }).first().click()
  const picture = 'wrapped/messages/inbox/synthetic/photos/pixel.png', audio = 'wrapped/messages/inbox/synthetic/audio/tone.wav'
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
  const wav = Buffer.alloc(8044)
  wav.write('RIFF'); wav.writeUInt32LE(8036, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28)
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40); wav.fill(128, 44)
  const raw = JSON.stringify({ title: 'Synthetic browser thread',
    participants: [{ name: 'Synthetic Self' }], messages: [{ sender_name: 'Synthetic Self', content: 'Generated for the browser check', timestamp_ms: 1,
      photos: [{ uri: picture }], audio_files: [{ uri: audio }] }] })
  const archive = source => syntheticZip([{ path: 'wrapped/messages/inbox/synthetic/message_1.json', bytes: source }, { path: picture, bytes: png }, { path: audio, bytes: wav }])
  await page.getByLabel('Choose Instagram export ZIP', { exact: true }).setInputFiles({ name: 'synthetic.zip', mimeType: 'application/zip',
    buffer: archive(raw) })
  await page.getByRole('combobox', { name: 'Who is me in this export?', exact: true }).click()
  await page.locator('[role="listbox"]').getByRole('option', { name: 'Synthetic Self', exact: true }).click()
  await page.getByRole('button', { name: 'Apply review', exact: true }).click()
  await page.getByText('Import complete', { exact: true }).waitFor()
  await expect(page).toHaveURL(/#\/import$/)
  await page.getByRole('button', { name: /Synthetic browser thread/ }).click()
  await expect(page.getByRole('heading', { name: 'Import export', exact: true })).toHaveCount(0)
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Import export', exact: true })).toBeVisible()
  await page.reload()
  await expect(page).toHaveURL(/#\/import$/)
  // Import the equivalent extracted directory through the actual folder
  // input, including its browser-provided relative paths and multiple media.
  const folder = join(directory, 'generated-export')
  for (const [path, bytes] of [['wrapped/messages/inbox/synthetic/message_1.json', raw], [picture, png], [audio, wav]]) {
    const target = join(folder, path)
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
  }
  await page.getByLabel('Choose extracted export folder', { exact: true }).setInputFiles(folder)
  await page.getByText('No changes to your history.', { exact: true }).waitFor()
  assert.equal((await library.conversations())[0].messageCount, 1)
  await page.getByRole('button', { name: /Synthetic browser thread/ }).click()
  await page.locator('[data-message-id]').first().waitFor()
  await page.reload()
  await page.locator('[data-message-id]').first().waitFor()
  assert.equal(await page.locator('[data-message-id]').count(), 1)
  await expect.poll(() => page.locator('.attachment img').evaluate(image => image.complete && image.naturalWidth === 1)).toBe(true)
  await page.locator('audio').waitFor()
  await page.locator('audio').evaluate(audio => { audio.scrollIntoView(); audio.load() })
  await expect.poll(() => page.locator('audio').evaluate(audio => audio.readyState)).toBeGreaterThanOrEqual(1)
  const range = await page.evaluate(async () => {
    const response = await fetch(document.querySelector('audio').src, { headers: { Range: 'bytes=0-3' } })
    return { status: response.status, body: await response.text() }
  })
  assert.deepEqual(range, { status: 206, body: 'RIFF' })
  assert.equal(await page.evaluate(async () => (await indexedDB.databases()).length), 0)
  await page.getByRole('button', { name: 'Ask Echo', exact: true }).click()
  const draftSaved = page.waitForResponse(response => response.request().method() === 'PUT' && /\/discussions\/[a-f0-9-]+$/.test(new URL(response.url()).pathname) && response.request().postDataJSON()?.draft === 'Synthetic saved draft')
  await page.getByLabel('Ask about this conversation', { exact: true }).fill('Synthetic saved draft')
  assert.equal((await draftSaved).status(), 200)
  await page.reload()
  if (await page.getByRole('button', { name: 'Ask Echo', exact: true }).getAttribute('aria-expanded') !== 'true') await page.getByRole('button', { name: 'Ask Echo', exact: true }).click()
  await expect(page.getByLabel('Ask about this conversation', { exact: true })).toHaveValue('Synthetic saved draft')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.getByText('Synthetic partial', { exact: false }).waitFor()
  assert.equal(dispatches, 1)
  await page.close()
  finishResponse()
  page = await context.newPage()
  await page.goto(app.origin)
  await page.locator('[data-message-id]').first().waitFor()
  if (await page.getByRole('button', { name: 'Ask Echo', exact: true }).getAttribute('aria-expanded') !== 'true') await page.getByRole('button', { name: 'Ask Echo', exact: true }).click()
  await page.getByText('Synthetic partial answer', { exact: false }).waitFor()
  assert.equal(dispatches, 1)
  if (process.env.ECHO_SYNTHETIC_CAPTURE) await page.screenshot({ path: process.env.ECHO_SYNTHETIC_CAPTURE, fullPage: true })
  const second = await context.newPage()
  await second.goto(app.origin)
  await second.getByRole('button', { name: 'Settings', exact: true }).click()
  await second.getByText('Echo is running', { exact: true }).waitFor()
  const unpaired = await browser.newContext()
  const response = await unpaired.request.get(app.origin + '/api/library/v1/status', { headers: { 'X-Echo-Request': '1' } })
  assert.equal(response.status(), 401)
  await unpaired.close()
  // A changed singleton has neither stable identity nor sufficient anchors.
  // Exercise explicit owner, conversation and occurrence decisions in the UI.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Import export', exact: true }).first().click()
  const changed = raw.replace('Generated for the browser check', 'Synthetic changed observation')
  const uploadChanged = () => page.getByLabel('Choose Instagram export ZIP', { exact: true }).setInputFiles({ name: 'synthetic-update.zip', mimeType: 'application/zip',
    buffer: archive(changed) })
  await uploadChanged()
  await page.getByRole('combobox', { name: 'Who is me in this export?', exact: true }).click()
  await page.locator('[role="listbox"]').getByRole('option', { name: 'Synthetic Self', exact: true }).click()
  const sameOwner = page.getByRole('checkbox', { name: /This is the same account/ })
  await sameOwner.focus(); await page.keyboard.press('Space')
  await page.getByRole('combobox', { name: 'Synthetic browser thread: how should this history be kept?', exact: true }).click()
  await page.locator('[role="listbox"]').getByRole('option', { name: 'Match Synthetic browser thread', exact: true }).click()
  await page.getByRole('button', { name: 'Apply review', exact: true }).click()
  await page.getByRole('combobox', { name: 'Resolve occurrence 1 from Synthetic Self', exact: true }).click()
  await page.locator('[role="listbox"]').getByRole('option', { name: 'Match existing occurrence 1', exact: true }).click()
  await page.getByRole('button', { name: 'Apply review', exact: true }).click()
  await page.getByText('Import complete', { exact: true }).waitFor()
  await uploadChanged()
  await page.getByText('No changes to your history.', { exact: true }).waitFor()
  assert.equal((await library.conversations())[0].messageCount, 1)
  const storedMessage = (await library.messages({ conversationId: (await library.conversations())[0].id }))[0]
  assert.equal(storedMessage.versionCount, 2)
  await page.getByRole('button', { name: 'Browse conversations', exact: true }).click()
  await page.goto(app.origin + '/#/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Delete library', exact: true }).click()
  if (process.env.ECHO_SYNTHETIC_CAPTURE) {
    await page.getByRole('dialog', { name: 'Delete library', exact: true }).evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)) })
    await page.screenshot({ path: process.env.ECHO_SYNTHETIC_CAPTURE.replace('.png', '-delete.png'), fullPage: true })
  }
  await page.getByRole('checkbox', { name: 'I understand this library cannot be restored.', exact: true }).focus()
  await page.keyboard.press('Space')
  await page.getByRole('button', { name: 'Permanently delete library', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete library', exact: true }).waitFor({ state: 'hidden' })
  assert.equal((await library.status()).owner, null)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(app.origin + '/#/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByText('Echo is running', { exact: true }).waitFor()
  const button = page.getByRole('button', { name: 'Quit Echo', exact: true })
  await button.focus()
  await page.keyboard.press('Enter')
  await page.getByText('Shutdown requested', { exact: true }).waitFor()
  assert.equal(quit, true)
  assert.equal(nonlocal.length, 0)
  standalone = await startApplication({ root, state: newInstance(0), createService: () => ({
    close: async () => {}, handle: (_req, res) => res.writeHead(404).end(),
  }) })
  const standaloneContext = await browser.newContext()
  const standalonePage = await standaloneContext.newPage()
  let libraryRequests = 0
  standalonePage.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/library/')) libraryRequests++ })
  await standalonePage.goto(standalone.origin)
  await standalonePage.getByRole('button', { name: 'Open export folder', exact: true }).filter({ visible: true }).waitFor()
  assert.equal(await standalonePage.getByRole('group', { name: 'Echo server', exact: true }).count(), 0)
  assert.equal(libraryRequests, 0)
  console.log(engineName + ' ' + browser.version() + ': library browser checks passed: launcher pairing, HttpOnly session, tab reuse, separate-profile denial, ZIP/extracted-folder equivalence and persisted owner/conversation/occurrence review, multiple attachments, image/audio metadata and media ranges, saved draft restore, accepted response after tab closure, explicit deletion, library restore without IndexedDB, mobile keyboard Quit, launch-file cleanup, and standalone compatibility.')
} finally {
  finishResponse()
  await browser?.close()
  await standalone?.close()
  await app?.close()
  await library?.close()
  await rm(directory, { recursive: true, force: true })
}
