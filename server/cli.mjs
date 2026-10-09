import { ensureTray } from './desktop.mjs'
import { fileURLToPath } from 'node:url'
import { launch, instanceStatus, quitInstance } from './launcher.mjs'
import { stateDirectory } from './runtime-state.mjs'
import { errors, publicErrorCode } from './launcher-errors.mjs'
import { libraryDirectory } from './library/client.mjs'

try {
  if (!['linux','win32'].includes(process.platform)) throw new Error('unsupported_platform')
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (![22, 24].includes(major) || major === 22 && minor < 13) throw new Error('unsupported_runtime')
  const [action = 'start', ...args] = process.argv.slice(2).filter(arg => arg !== '--')
  let port
  let background = false
  for (let i = 0; i < args.length; i++) {
    if (action === 'start' && args[i] === '--background' && !background) background = true
    else if (action === 'start' && args[i] === '--port' && port === undefined && /^\d+$/.test(args[i + 1] ?? '')) port = Number(args[++i])
    else throw new Error('invalid_options')
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('invalid_options')
  const directory = stateDirectory()
  if (action === 'start') {
    const result = await launch({ directory, root: fileURLToPath(new URL('../dist', import.meta.url)), port, background, libraryDirectory: libraryDirectory() })
    const tray = await ensureTray()
    process.stdout.write(`Echo is running at ${result.origin}\n`)
    if (!tray) process.stdout.write('The system tray is unavailable. Use Quit Echo in the browser or pnpm server:quit.\n')
  } else if (action === 'status') {
    const result = await instanceStatus(directory)
    process.stdout.write(result.status === 'unavailable' ? 'No authenticated Echo instance is available.\n' : `Echo is ${result.status} at ${result.origin}\n`)
    if (result.status === 'unavailable') process.exitCode = 1
  } else if (action === 'quit') {
    await quitInstance(directory)
    process.stdout.write('Echo has stopped.\n')
  } else throw new Error('invalid_options')
} catch (error) {
  process.stderr.write(`${errors[publicErrorCode(error)]}\n`)
  process.exitCode = 1
}
