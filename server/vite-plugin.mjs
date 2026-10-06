import { createChatGPTService } from './chatgpt.mjs'

export function chatGPTPlugin(createService = createChatGPTService) {
  const shutdown = new Set()
  function attach(server) {
    let service
    const close = () => service?.close()
    shutdown.add(close)
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/api/chatgpt/') && !req.url?.startsWith('/auth/callback') && !req.url?.startsWith('/auth/complete')) return next()
      const address = server.httpServer?.address()
      if (!address || typeof address === 'string') { res.writeHead(503).end(); return }
      service ??= createService({ origin: `http://127.0.0.1:${address.port}` })
      void service.handle(req, res, next)
    })
    server.httpServer?.once('close', () => { void close() })
  }
  return { name: 'echo-local-chatgpt', configureServer: attach, configurePreviewServer: attach, async closeBundle() { await Promise.all([...shutdown].map(close => close())) } }
}
