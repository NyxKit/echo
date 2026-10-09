import { createServer } from 'node:http'
import { lstat, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createChatGPTService } from './chatgpt.mjs'
import { CONTROL_PATH, createControlAuthority } from './local-control.mjs'
import { createBrowserSessions } from './library/browser-sessions.mjs'
import { createAnalysisJobs } from './library/analysis-jobs.mjs'
import { LIBRARY_PATH, createLibraryHttp } from './library/http.mjs'

const mime = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' }

async function buildFile(root, path) {
  const parts = path.split('/').filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('invalid_asset')
  }
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW)
  if (!(await file.stat()).isFile()) { await file.close(); throw new Error('invalid_asset') }
  return file
}

export async function startApplication({ root, state, createService = createChatGPTService, shutdownMs = 5000, onQuit = () => {}, library, browserDirectory, browserNow }) {
  let buildRoot
  try {
    if ((await lstat(root)).isSymbolicLink()) throw new Error('invalid_build')
    buildRoot = await realpath(root)
    await (await buildFile(buildRoot, 'index.html')).close()
  } catch { throw new Error('build_missing') }
  let service
  let closing
  let stopping = false
  let origin
  let sessions, libraryHttp, analysisJobs
  let ready = false
  const authority = createControlAuthority(state)
  const server = createServer({ maxHeaderSize: 16_384, requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    void handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.maxRequestsPerSocket = 1000
  server.keepAliveTimeout = 5000

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    if (req.headers.host !== new URL(origin).host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
        !req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 16_384) { res.writeHead(403).end(); return }
    if (!ready) { res.writeHead(503).end(); return }
    if (req.url.startsWith(CONTROL_PATH)) {
      if (!authority.accept(req)) { res.writeHead(403).end(); return }
      if (req.method === 'GET' && req.url === `${CONTROL_PATH}status`) {
        authority.reply(req, res, 200, { version: 1, instanceId: state.instanceId, status: stopping ? 'stopping' : 'ready', ...(sessions ? { library: true } : {}) }); return
      }
      if (req.method === 'POST' && req.url === `${CONTROL_PATH}launch` && sessions && !stopping) {
        try {
          const launchId = await sessions.launch()
          authority.reply(req, res, 200, { version: 1, instanceId: state.instanceId, status: 'ready', launchId })
        } catch { authority.reply(req, res, 503, { version: 1, instanceId: state.instanceId, status: 'unavailable' }) }
        return
      }
      if (req.method === 'POST' && req.url === `${CONTROL_PATH}quit`) {
        stopping = true
        res.once('finish', () => onQuit())
        authority.reply(req, res, 200, { version: 1, instanceId: state.instanceId, status: 'stopping' }); return
      }
      res.writeHead(404).end(); return
    }
    if (stopping) { res.writeHead(503).end(); return }
    if (libraryHttp && req.url.startsWith(LIBRARY_PATH)) return libraryHttp(req, res)
    if (req.url.startsWith('/api/chatgpt/') || ['/auth/callback', '/auth/complete'].includes(req.url.split('?')[0])) {
      if (sessions && req.url.startsWith('/api/chatgpt/')) {
        try { sessions.authorize(req) } catch { res.writeHead(401).end(); return }
        if (req.url.split('?')[0] === '/api/chatgpt/analyze') { res.writeHead(404).end(); return }
      }
      return service.handle(req, res)
    }
    const path = req.url.split('?')[0]
    // The file-form handoff redirects across origins. The public shell may be
    // navigated to, while every private API still requires its own authority.
    const publicNavigation = req.method === 'GET' && ['/', '/index.html'].includes(path) &&
      req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document'
    if ((req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') && !publicNavigation) { res.writeHead(403).end(); return }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return }
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) { res.writeHead(400).end(); return }
    const extension = path.slice(path.lastIndexOf('.'))
    const index = path === '/' || path === '/index.html'
    if (!index && (!/^\/assets\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(path) || !mime[extension])) { res.writeHead(404).end(); return }
    let file
    try { file = await buildFile(buildRoot, index ? 'index.html' : path) }
    catch { res.writeHead(404).end(); return }
    try {
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'")
      if (index && library) {
        const original = await file.readFile('utf8')
        const marker = '<meta name="echo-runtime" content="local-library">'
        const html = /<head[\s>]/i.test(original) ? original.replace(/<head[^>]*>/i, `$&${marker}`) : marker + original
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) })
        res.end(req.method === 'HEAD' ? undefined : html)
        return
      }
      res.writeHead(200, { 'Content-Type': index ? 'text/html; charset=utf-8' : mime[extension], 'Content-Length': (await file.stat()).size })
      if (req.method === 'HEAD') res.end()
      else await pipeline(file.createReadStream({ autoClose: false }), res)
    } finally { await file.close() }
  }

  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(state.port, '127.0.0.1', resolve) })
    state.port = server.address().port
    origin = `http://127.0.0.1:${state.port}`
    service = createService({ origin })
    if (library) {
      sessions = await createBrowserSessions({ origin, directory: browserDirectory, now: browserNow })
      analysisJobs = createAnalysisJobs({ library, provider: service })
      libraryHttp = createLibraryHttp({ library, sessions, origin, analysisJobs, onQuit: () => { stopping = true; onQuit() } })
    }
    ready = true
  } catch (error) {
    server.close()
    await sessions?.close()
    await analysisJobs?.close()
    await service?.close()
    throw new Error(error.code === 'EADDRINUSE' ? 'port_in_use' : 'startup_failed')
  }
  return {
    origin,
    close() {
      closing ??= (async () => {
        stopping = true
        let timeout
        const httpClosed = new Promise(resolve => server.close(resolve))
        try {
          await Promise.race([
            Promise.all([analysisJobs?.close(), service.close(), sessions?.close(), httpClosed]),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('shutdown_timeout')), shutdownMs) }),
          ])
        } finally { clearTimeout(timeout); server.closeAllConnections() }
      })()
      return closing
    },
  }
}
