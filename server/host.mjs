import { startInstance } from './instance.mjs'
import { publicErrorCode } from './launcher-errors.mjs'

let instance
let quitting = false
const configurationTimeout = setTimeout(() => process.exit(1), 10_000)
const report = (value, done = () => {}) => {
  if (process.connected) process.send(value, done)
  else done()
}

async function quit() {
  if (quitting) return
  quitting = true
  // This process is the final boundary for a stalled provider or host adapter.
  const deadline = setTimeout(() => process.exit(1), 6500)
  try { await instance?.close(); clearTimeout(deadline); process.exit(0) }
  catch { process.exit(1) }
}

process.once('message', async configuration => {
  clearTimeout(configurationTimeout)
  const startupTimeout = setTimeout(() => process.exit(1), 10_000)
  try {
    instance = await startInstance({ ...configuration, onQuit: quit })
    clearTimeout(startupTimeout)
    process.on('SIGTERM', quit)
    process.on('SIGINT', quit)
    report({ status: 'ready' })
  } catch (error) {
    clearTimeout(startupTimeout)
    report({ status: 'failed', code: publicErrorCode(error) }, () => process.exit(1))
  }
})
