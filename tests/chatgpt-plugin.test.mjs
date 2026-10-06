import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { chatGPTPlugin } from '../server/vite-plugin.mjs'

describe('connection service Vite lifecycle', () => {
  it('waits for asynchronous shutdown during a dev-server restart', async () => {
    let release
    const finished = new Promise(resolve => { release = resolve })
    const service = { handle: vi.fn(), close: vi.fn(() => finished) }
    const plugin = chatGPTPlugin(() => service)
    const httpServer = new EventEmitter()
    httpServer.address = () => ({ port: 5173 })
    const server = { httpServer, middlewares: { use: vi.fn() } }
    plugin.configureServer(server)
    server.middlewares.use.mock.calls[0][0]({ url: '/api/chatgpt/status' }, {}, vi.fn())
    httpServer.emit('close')
    let closed = false
    const closing = plugin.closeBundle().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    release()
    await closing
    expect(closed).toBe(true)
  })
})
