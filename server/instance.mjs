import { join } from 'node:path'
import { acquireServiceLock } from './service-lock.mjs'
import { startApplication } from './application.mjs'
import { configuredPort, ensurePrivateDirectory, newInstance, publishInstance, readInstance, removeInstance } from './runtime-state.mjs'
import { openLibrary } from './library/client.mjs'

export async function startInstance({ directory, root, port, onQuit, createService, shutdownMs, libraryDirectory }) {
  try { await ensurePrivateDirectory(directory) } catch { throw new Error('state_unavailable') }
  const lease = await acquireServiceLock(join(directory, 'instance.lock'))
  let app
  let state
  let closing
  let library
  try {
    const previous = await readInstance(directory)
    state = newInstance(port ?? previous?.port ?? await configuredPort(directory))
    if (libraryDirectory) library = await openLibrary(libraryDirectory)
    app = await startApplication({ root, state, createService, shutdownMs, onQuit, library, browserDirectory: directory })
    await publishInstance(directory, state)
  } catch (error) {
    await app?.close()
    await library?.close()
    await lease.close()
    throw error
  }
  return {
    origin: app.origin,
    close() {
      closing ??= (async () => {
        // A failed cleanup keeps the lease. The host must exit before another
        // process can recover stale state and start accepting work.
        await app.close()
        await library?.close()
        await removeInstance(directory, state)
        await lease.close()
      })()
      return closing
    },
  }
}
