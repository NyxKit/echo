import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.ECHO_TEST_PORT ?? 5173)
const browser = process.env.ECHO_TEST_BROWSER ?? 'chromium'
if (!['chromium', 'firefox', 'webkit'].includes(browser)) throw new Error('Unsupported test browser')
const browserName = browser as 'chromium' | 'firefox' | 'webkit'
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  workers: process.env.CI ? 4 : undefined,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'off', screenshot: 'off', video: 'off',
    ...(process.env.ECHO_TEST_CHANNEL ? { channel: process.env.ECHO_TEST_CHANNEL } : {}),
    ...(process.env.ECHO_TEST_EXECUTABLE ? { launchOptions: { executablePath: process.env.ECHO_TEST_EXECUTABLE } } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices[browser === 'firefox' ? 'Desktop Firefox' : browser === 'webkit' ? 'Desktop Safari' : 'Desktop Chrome'], browserName, viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName, defaultBrowserType: browserName,
      ...(browser === 'firefox' ? { isMobile: false, hasTouch: false, userAgent: undefined } : {}) } },
  ],
  webServer: { command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !process.env.CI },
})
