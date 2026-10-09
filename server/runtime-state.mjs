import { windows, windowsData, checkPrivate, ensureDirectory } from './platform.mjs'
import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const DEFAULT_PORT = 47831
export function stateDirectory(env = process.env) {
  if (windows) return join(windowsData(env), 'state')
  return join(env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(homedir(), '.local', 'state'), 'echo')
}

export async function ensurePrivateDirectory(directory) {
  ensureDirectory(directory)
}

export function newInstance(port) {
  return { version: 1, instanceId: randomUUID(), secret: randomBytes(32).toString('hex'), port }
}

async function readPrivateJson(directory, name) {
  let file
  try {
    await ensurePrivateDirectory(directory)
    file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await file.stat()
    checkPrivate(join(directory, name), info)
    if (!info.isFile() || info.size > 4096) throw new Error('state_unavailable')
    return JSON.parse(await file.readFile('utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new Error('state_unavailable')
  } finally { await file?.close() }
}

const validPort = value => Number.isInteger(value) && value >= 1 && value <= 65535

export async function readInstance(directory) {
  const value = await readPrivateJson(directory, 'instance.json')
  if (value === undefined) return undefined
  if (value?.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.instanceId) || !/^[a-f0-9]{64}$/.test(value.secret) || !validPort(value.port)) throw new Error('state_unavailable')
  return value
}

export async function configuredPort(directory) {
  const value = await readPrivateJson(directory, 'port.json')
  if (value === undefined) return DEFAULT_PORT
  if (value?.version !== 1 || !validPort(value.port)) throw new Error('state_unavailable')
  return value.port
}

async function writePrivateJson(directory, name, value) {
  const temporary = join(directory, `${name}-${randomUUID()}.tmp`)
  let file
  try {
    file = await open(temporary, 'wx', 0o600)
    await file.writeFile(JSON.stringify(value))
    await file.sync()
    await file.close(); file = undefined
    await rename(temporary, join(directory, name))
  } finally {
    await file?.close()
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

export async function publishInstance(directory, state) {
  await writePrivateJson(directory, 'port.json', { version: 1, port: state.port })
  await writePrivateJson(directory, 'instance.json', state)
}

export async function removeInstance(directory, state) {
  const saved = await readInstance(directory)
  if (saved?.instanceId === state.instanceId) await unlink(join(directory, 'instance.json'))
}
