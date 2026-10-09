import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { APP_NAME, APP_BASELINE } from './src/config'
import { chatGPTPlugin } from './server/vite-plugin.mjs'

const branding = { APP_NAME, APP_BASELINE }
function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export default defineConfig({
  base: './',
  plugins: [vue(), {
    name: 'private-development-boundary',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let path = (req.url ?? '/').split('?')[0]!
        try { path = decodeURIComponent(path).replaceAll('\\', '/') } catch { res.writeHead(400).end(); return }
        // Refuse before filesystem lookup, including nonexistent probe names.
        if (/(?:^|\/)(?:data|build|release)(?:\/|$)/i.test(path)) { res.writeHead(403).end('Forbidden'); return }
        next()
      })
    },
  }, chatGPTPlugin(), {
    name: 'app-branding',
    transformIndexHtml: {
      order: 'pre',
      handler: html => html.replace(/%APP_(NAME|BASELINE)%/g, (_, key: 'NAME' | 'BASELINE') => escapeHtml(branding[`APP_${key}`])),
    },
  }],
  publicDir: false,
  server: {
    host: '127.0.0.1',
    fs: { deny: ['**/data/**', '**/build/**', '**/release/**', '**/.git/**', '**/.env*', '**/*.{crt,pem}', '**/server/**'] },
    watch: { ignored: ['**/data/**', '**/build/**', '**/release/**'], followSymlinks: false },
  },
  css: {
    postcss: {
      plugins: [{
        postcssPlugin: 'local-fonts-only',
        AtRule: {
          import(rule) {
            if (/https?:|\/\//i.test(rule.params)) rule.remove()
          },
        },
      }],
    },
  },
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'] },
})
