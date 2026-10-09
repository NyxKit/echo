import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { startApplication } from '../server/application.mjs'
import { openLibrary } from '../server/library/client.mjs'
import { newInstance, publishInstance } from '../server/runtime-state.mjs'
import { launch } from '../server/launcher.mjs'
import { syntheticZip } from '../tests/helpers/synthetic-zip.mjs'

// This is a stable Firefox check through standard WebDriver, not Playwright's
// patched Firefox. The entire app, driver and new profile run in one isolated
// network namespace; no real browser profile or desktop keyring is mounted.
if (!process.argv.includes('--inside')) {
  if (process.platform !== 'linux') throw new Error('The isolated stable Firefox check requires Linux')
  const source = fileURLToPath(new URL('../', import.meta.url))
  const driver = resolve(process.env.ECHO_GECKODRIVER ?? 'build/geckodriver/geckodriver')
  await access(driver)
  const scratch = await mkdtemp(join(tmpdir(), 'echo-synthetic-firefox-'))
  try {
    for (const name of ['profile', 'cache', 'config', 'data', 'runtime']) await mkdir(join(scratch, name), { mode: 0o700 })
    const args = ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
      '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64',
      '--dir', '/etc', '--ro-bind', '/etc/passwd', '/etc/passwd', '--ro-bind', '/etc/group', '/etc/group', '--ro-bind', '/etc/fonts', '/etc/fonts',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/home', '--dir', '/work',
      '--bind', scratch, '/scratch', '--ro-bind', process.execPath, '/runtime/node', '--ro-bind', driver, '/runtime/geckodriver']
    for (const name of ['server', 'shared', 'dist', 'node_modules', 'tests/helpers']) args.push('--ro-bind', join(source, name), '/work/' + name)
    args.push('--ro-bind', fileURLToPath(import.meta.url), '/work/scripts/check-firefox-stable.mjs', '--chdir', '/work',
      '--setenv', 'PATH', '/usr/bin', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'XDG_CACHE_HOME', '/scratch/cache',
      '--setenv', 'XDG_CONFIG_HOME', '/scratch/config', '--setenv', 'XDG_DATA_HOME', '/scratch/data', '--setenv', 'XDG_RUNTIME_DIR', '/scratch/runtime',
      '--setenv', 'ECHO_SYNTHETIC_FIREFOX', '1', '/runtime/node', '/work/scripts/check-firefox-stable.mjs', '--inside')
    const child = spawn('bwrap', args, { stdio: ['ignore', 'inherit', 'inherit'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
    try { const [code] = await once(child, 'exit'); assert.equal(code, 0, 'Isolated Firefox check failed') }
    finally { clearTimeout(timer) }
  } finally { await rm(scratch, { recursive: true, force: true }) }
} else {
  assert.equal(process.env.ECHO_SYNTHETIC_FIREFOX, '1')
  assert.equal(process.env.XDG_DATA_HOME, '/scratch/data')
  let driver, session, app, library, finishResponse, dispatches = 0, quit = false
  const gate = new Promise(resolve => { finishResponse = resolve })
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const endpoint = `http://127.0.0.1:${port}`
  async function command(method, path, body) {
    const response = await fetch(endpoint + path, { method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
    const { value } = await response.json()
    if (!response.ok) throw Object.assign(new Error('Synthetic WebDriver command failed: ' + method + ' ' + path.replace(/\/session\/[^/]+/, '/session/current') + ' (' + value?.error + ')'), { code: value?.error })
    return value
  }
  const send = (method, path, body) => command(method, '/session/' + session + path, body)
  const evaluate = (script, args = []) => send('POST', '/execute/sync', { script, args })
  async function until(check, description) {
    for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await delay(100) }
    throw new Error('Synthetic Firefox timed out: ' + description)
  }
  const text = label => until(() => evaluate('return document.body.innerText.includes(arguments[0])', [label]), label)
  const find = (selector, using = 'css selector') => send('POST', '/element', { using, value: selector })
  const elementId = element => element['element-6066-11e4-a52e-4f735466cecf']
  async function click(selector, using = 'css selector') {
    let element
    await until(async () => {
      element = await evaluate(`
        const [selector, using] = arguments;
        const nodes = using === 'xpath'
          ? (() => { const result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE); return Array.from({ length: result.snapshotLength }, (_, i) => result.snapshotItem(i)); })()
          : [...document.querySelectorAll(selector)];
        return nodes.find(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.disabled) ?? null;
      `, [selector, using])
      return !!element
    }, 'visible control ' + selector)
    await send('POST', '/element/' + elementId(element) + '/click', {})
  }
  // Test labels are entirely generated and contain no quote characters.
  const button = label => click(`//button[normalize-space(.)='${label}' or @aria-label='${label}'] | //*[@role='button' and normalize-space(.)='${label}']`, 'xpath')
  async function input(selector, value, clear = false) {
    await until(() => evaluate('return !!document.querySelector(arguments[0])', [selector]), 'input ' + selector)
    const id = elementId(await find(selector))
    if (clear) await send('POST', '/element/' + id + '/clear', {})
    await send('POST', '/element/' + id + '/value', { text: value })
  }
  const navigate = url => send('POST', '/url', { url })
  const timelineReady = () => until(() => evaluate('return !!document.querySelector("[data-message-id]")'), 'loaded conversation timeline')
  try {
    driver = spawn('/runtime/geckodriver', ['--host', '127.0.0.1', '--port', String(port), '--log', 'fatal'], { stdio: 'ignore' })
    await until(async () => { if (driver.exitCode !== null) throw new Error('Synthetic WebDriver exited'); try { return (await command('GET', '/status')).ready } catch { return false } }, 'driver readiness')
    const opened = await command('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'firefox',
      'moz:firefoxOptions': { binary: '/usr/bin/firefox', args: ['-headless', '-profile', '/scratch/profile'], prefs: {
        'browser.shell.checkDefaultBrowser': false, 'browser.startup.homepage': 'about:blank', 'datareporting.policy.dataSubmissionEnabled': false,
        'toolkit.telemetry.enabled': false, 'app.update.auto': false,
      } } } } })
    session = opened.sessionId
    assert.match(opened.capabilities.browserVersion, /^\d+\./)
    await send('POST', '/window/rect', { width: 1440, height: 1000 })
    const runtime = '/scratch/runtime/echo'
    await mkdir(runtime, { mode: 0o700 })
    library = await openLibrary('/scratch/library')
    const state = newInstance(0), root = '/work/dist'
    app = await startApplication({ root, state, library, browserDirectory: runtime, onQuit: () => { quit = true },
      createService: () => ({ close: async () => {}, handle: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(req.url.endsWith('/models')
          ? { models: [{ id: 'synthetic-model', name: 'Synthetic model' }] } : { state: 'connected' }))
      }, prepareJob: async () => ({ providerAccount: 'a'.repeat(64), run: async ({ onEvent }) => {
        dispatches++; await onEvent({ type: 'delta', delta: 'Synthetic partial ' }); await gate
        await onEvent({ type: 'delta', delta: 'answer [[p1:m1]]' }); await onEvent({ type: 'complete' })
      } }) }) })
    await publishInstance(runtime, state)
    await navigate(app.origin)
    await button('Settings'); await text('Connect this browser')
    let handoff
    await launch({ directory: runtime, root, browser: async target => { handoff = target; await navigate(target) } })
    await until(async () => (await send('GET', '/url')).startsWith(app.origin), 'file handoff')
    await button('Settings'); await text('Echo is running')
    assert.equal(await evaluate("return document.cookie.includes('echo_library_')"), false)
    await assert.rejects(access(fileURLToPath(handoff)))
    await button('Import export')
    const relative = 'messages/inbox/synthetic/message_1.json'
    const picture = 'messages/inbox/synthetic/photos/pixel.png', audio = 'messages/inbox/synthetic/audio/tone.wav'
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
    const wav = Buffer.alloc(8044)
    wav.write('RIFF'); wav.writeUInt32LE(8036, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28)
    wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40); wav.fill(128, 44)
    const raw = JSON.stringify({ title: 'Synthetic stable thread', participants: [{ name: 'Synthetic Self' }],
      messages: [{ sender_name: 'Synthetic Self', content: 'Generated stable browser message', timestamp_ms: 1, photos: [{ uri: picture }], audio_files: [{ uri: audio }] }] })
    await writeFile('/scratch/generated.zip', syntheticZip([{ path: relative, bytes: raw }, { path: picture, bytes: pixel }, { path: audio, bytes: wav }]))
    await mkdir('/scratch/export/messages/inbox/synthetic', { recursive: true })
    await mkdir('/scratch/export/messages/inbox/synthetic/photos'); await mkdir('/scratch/export/messages/inbox/synthetic/audio')
    await writeFile('/scratch/export/' + relative, raw)
    await writeFile('/scratch/export/' + picture, pixel); await writeFile('/scratch/export/' + audio, wav)
    await input('[aria-label="Choose Instagram export ZIP"]', '/scratch/generated.zip')
    await text('Review uncertain matches')
    await click('[role="combobox"][aria-label="Who is me in this export?"]')
    await click("//*[@role='option' and normalize-space(.)='Synthetic Self']", 'xpath')
    await button('Apply review'); await text('Import complete')
    assert.match(await send('GET', '/url'), /#\/import$/)
    let folderChecked = true
    try { await input('[aria-label="Choose extracted export folder"]', '/scratch/export') }
    catch (error) {
      // WebDriver Classic specifies files, not directories; geckodriver
      // currently rejects a directory path. Keep that gate explicit.
      if (error.code !== 'invalid argument') throw error
      folderChecked = false
      await input('[aria-label="Choose Instagram export ZIP"]', '/scratch/generated.zip')
    }
    await text('No changes to your history.')
    assert.equal((await library.conversations())[0].messageCount, 1)
    await click('.conversation')
    await text('Generated stable browser message')
    await send('POST', '/refresh', {})
    await timelineReady()
    await until(() => evaluate('return [...document.querySelectorAll(".attachment img")].some(image => image.complete && image.naturalWidth === 1)'), 'managed image decoding')
    await until(() => evaluate('return !!document.querySelector("audio")'), 'audio element')
    await evaluate('const audio = document.querySelector("audio"); audio.scrollIntoView({block: "center"}); audio.load()')
    await until(() => evaluate('return document.querySelector("audio")?.readyState >= 1'), 'audio metadata')
    const range = await send('POST', '/execute/async', { script: `
      const done = arguments[arguments.length - 1];
      fetch(document.querySelector('audio').src, { headers: { Range: 'bytes=0-3' } })
        .then(async response => done({ status: response.status, body: await response.text() })).catch(() => done(null));`, args: [] })
    assert.deepEqual(range, { status: 206, body: 'RIFF' })
    await button('Ask Echo')
    const composer = '#analysis-question'
    await input(composer, 'Synthetic saved draft', true)
    const conversationId = (await library.conversations())[0].id
    await until(async () => {
      const discussions = await library.discussions({ conversationId })
      return discussions.length && (await library.discussion({ discussionId: discussions[0].id })).draft === 'Synthetic saved draft'
    }, 'draft committed to library')
    await text('Saved in your Echo library')
    await send('POST', '/refresh', {})
    await timelineReady()
    if (!await evaluate('return document.querySelector(arguments[0])?.getAttribute("aria-expanded") === "true"', ['[aria-controls="analysis-shelf"]'])) await button('Ask Echo')
    await until(() => evaluate('return document.querySelector(arguments[0])?.value === arguments[1]', [composer, 'Synthetic saved draft']), 'saved draft restore')
    await text('Sending shares this context with OpenAI.')
    await button('Send message'); await text('Synthetic partial')
    assert.equal(dispatches, 1)
    const original = await send('GET', '/window')
    const replacement = await send('POST', '/window/new', { type: 'tab' })
    await send('POST', '/window', { handle: original })
    await send('DELETE', '/window')
    finishResponse()
    await send('POST', '/window', { handle: replacement.handle })
    await navigate(app.origin)
    await timelineReady()
    if (!await evaluate('return document.querySelector(arguments[0])?.getAttribute("aria-expanded") === "true"', ['[aria-controls="analysis-shelf"]'])) await button('Ask Echo')
    await text('Synthetic partial answer')
    assert.equal(dispatches, 1)
    await button('Settings'); await button('Delete library')
    await text('I understand this library cannot be restored.')
    await click('[role="checkbox"]')
    await button('Permanently delete library')
    await until(async () => (await library.status()).owner === null, 'library deletion')
    await until(() => evaluate('return !document.querySelector("dialog[open]")'), 'deletion dialog closure')
    await assert.rejects(library.conversations(), /library_owner_required/)
    await send('POST', '/window/rect', { width: 390, height: 844 })
    await navigate(app.origin + '/#/settings')
    await text('Echo is running'); await button('Quit Echo')
    await text('Shutdown requested'); assert.equal(quit, true)
    console.log('Firefox Stable ' + opened.capabilities.browserVersion + ': isolated browser checks passed: file pairing, HttpOnly session, ZIP import, repeat import, route/reload, image/audio metadata and media ranges, saved draft, context disclosure, response after tab closure without resend, deletion and narrow-viewport Quit.')
    console.log(folderChecked ? 'Extracted-folder upload also passed.' : 'Extracted-folder picker remains a manual stable-Firefox gate: geckodriver rejected the directory upload command.')
  } finally {
    finishResponse?.()
    if (session) await send('DELETE', '').catch(() => {})
    if (driver?.exitCode === null) { const exited = once(driver, 'exit'); driver.kill('SIGKILL'); await exited }
    await app?.close(); await library?.close()
  }
}
