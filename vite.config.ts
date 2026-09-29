import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  publicDir: false,
  server: {
    host: '127.0.0.1',
    fs: { deny: ['**/data/**', '**/.git/**', '**/.env*', '**/*.{crt,pem}'] },
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
  test: { include: ['tests/**/*.test.ts'] },
})
