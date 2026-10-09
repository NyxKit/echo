import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Mount an explicit source allowlist, never the repository root, home, data,
// browser profiles or OS credential stores. Docker publishes no host ports.
if (process.platform !== 'linux') throw new Error('This isolated browser check requires a Linux host')
const require = createRequire(import.meta.url)
const version = require('@playwright/test/package.json').version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A released Playwright version is required')
const root = fileURLToPath(new URL('../', import.meta.url))
const options = process.argv.slice(2)
if (options.length > 1 || options.some(option => !['--viewer-only', '--library-only'].includes(option))) throw new Error('Use --viewer-only or --library-only, or neither for both checks')
const checks = []
if (!options.includes('--library-only')) checks.push('/runtime/node node_modules/@playwright/test/cli.js test --workers=2')
if (!options.includes('--viewer-only')) checks.push('/runtime/node scripts/check-library-browser.mjs')
const args = ['run', '--rm', '--network', 'none', '--workdir', '/work',
  '--env', 'CI=1', '--env', 'ECHO_TEST_BROWSER=webkit', '--env', 'ECHO_BROWSER=webkit', '--env', 'ECHO_TEST_PORT=5199']
for (const name of ['src', 'server', 'shared', 'tests', 'scripts', 'dist', 'node_modules',
  'package.json', 'index.html', 'vite.config.ts', 'playwright.config.ts', 'tsconfig.json']) {
  args.push('--mount', `type=bind,source=${join(root, name)},target=/work/${name},readonly`)
}
args.push('--tmpfs', '/work/node_modules/.vite', '--tmpfs', '/work/node_modules/.vite-temp',
  '--mount', `type=bind,source=${process.execPath},target=/runtime/node,readonly`,
  `mcr.microsoft.com/playwright:v${version}-noble`, 'sh', '-c',
  checks.join(' && '))
const child = spawn('docker', args, { stdio: 'inherit' })
child.on('error', () => { console.error('The isolated browser check requires Docker and its matching Playwright image.'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
