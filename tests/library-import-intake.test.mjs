import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { syntheticZip } from './helpers/synthetic-zip.mjs'
import { extractZip } from '../server/imports/extract.mjs'
import { importLimits, logicalPath, pathRegistry, MiB } from '../server/imports/limits.mjs'
import { validateExport, fileResolver } from '../server/imports/validate.mjs'
const roots = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'echo-synthetic-intake-')); roots.push(root)
  const output = join(root, 'files'); await mkdir(output, { mode: 0o700 })
  return { root, output }
}
async function extract(entries, options = {}, overrides) {
  const { root, output } = await workspace(), input = join(root, 'synthetic.zip')
  await writeFile(input, syntheticZip(entries, options), { mode: 0o600 })
  return { output, files: await extractZip(input, output, overrides) }
}
const conversation = JSON.stringify({ title: 'Synthetic thread', participants: [{ name: 'Synthetic Self', is_self: true }, { name: 'Synthetic Other' }],
  messages: [{ sender_name: 'Synthetic Self', timestamp_ms: 1, content: 'Generated text', unknown: 123 }] })

describe('bounded server import intake', () => {
  it('accepts stored, deflated and ZIP64 records and writes only generated physical names', async () => {
    for (const zip64 of [false, true]) {
      const { output, files } = await extract([{ path: 'wrapper/messages/inbox/thread/message_1.json', bytes: conversation }, { path: 'wrapper/media/synthetic.bin', bytes: 'generated', method: 0 }], { zip64 })
      expect(files).toHaveLength(2)
      expect(await readFile(join(output, files[0].id), 'utf8')).toBe(conversation)
      expect(files.every(file => /^[a-f0-9-]{36}$/.test(file.id))).toBe(true)
      const result = await validateExport(output, files)
      expect(result.conversations).toBe(1)
      expect(result.owner.candidates).toContain('Synthetic Self')
    }
  })
  it('rejects cross-platform traversal, devices, path aliases and file/directory conflicts', async () => {
    for (const path of ['../escape', '/absolute', 'C:/drive', 'a\\b', '//host/share', 'a/../b', 'a/./b', 'a//b', 'a/NUL.txt', 'COM1', 'a/trailing.', 'a/trailing ', 'a/x:y', 'a/%2e%2e/x']) {
      expect(() => logicalPath(path)).toThrow('import_path')
    }
    for (const paths of [['a/b', 'A/B'], ['a/é', 'a/e\u0301'], ['a', 'a/b'], ['a/b', 'a']]) {
      const registry = pathRegistry()
      registry.add(paths[0]); expect(() => registry.add(paths[1])).toThrow('import_collision')
    }
    await expect(extract([{ path: 'same', bytes: 'a' }, { path: 'SAME', bytes: 'b' }])).rejects.toThrow('import_collision')
    await expect(extract([{ path: '../escape', bytes: '' }])).rejects.toThrow()
  })
  it('rejects encryption, split volumes, symlinks, special files, unsupported methods and CRC failures', async () => {
    for (const entry of [{ encrypted: true }, { disk: 1 }, { mode: 0o120777 }, { mode: 0o020600 }, { method: 99 }, { crc: 0 }]) {
      await expect(extract([{ path: 'synthetic.bin', bytes: 'generated', ...entry }])).rejects.toThrow()
    }
    for (const zip64 of [false, true]) await expect(extract([{ path: 'synthetic', bytes: 'x' }], { disk: 1, zip64 })).rejects.toThrow('import_zip_invalid')
  })
  it('rejects truncated archives and enforces actual expansion, entry count, disk reserve and cancellation', async () => {
    const { root, output } = await workspace(), input = join(root, 'synthetic.zip')
    await writeFile(input, syntheticZip([{ path: 'synthetic', bytes: 'abc' }]).subarray(0, 40))
    await expect(extractZip(input, output)).rejects.toThrow('import_zip_invalid')
    const limits = { ...importLimits, entry: 1024 }
    await expect(extract([{ path: 'large', bytes: Buffer.alloc(2048) }], {}, { limits })).rejects.toThrow('import_limit')
    await expect(extract([{ path: 'a' }, { path: 'b' }], {}, { limits: { ...importLimits, entries: 1 } })).rejects.toThrow('import_limit')
    await expect(extract([{ path: 'a', bytes: 'x' }], {}, { limits: { ...importLimits, reserve: Number.MAX_SAFE_INTEGER } })).rejects.toThrow('import_disk_full')
    const controller = new AbortController(); controller.abort()
    await expect(extract([{ path: 'a', bytes: 'x' }], {}, { signal: controller.signal })).rejects.toThrow('import_cancelled')
  })
  it('leaves nested archives inert and explains HTML-only exports', async () => {
    const { output, files } = await extract([{ path: 'nested.zip', bytes: syntheticZip([{ path: 'nested.json', bytes: conversation }]) }, { path: 'messages.html', bytes: '<html>synthetic</html>' }])
    expect(files).toHaveLength(2)
    await expect(validateExport(output, files)).rejects.toThrow('import_html_only')
  })
  it('validates a selected folder with the same source records and resolves media without basename guesses', async () => {
    const { output } = await workspace(), id = randomUUID()
    await writeFile(join(output, id), conversation, { mode: 0o600 })
    const files = [{ id, path: 'wrapped/messages/inbox/thread/message_1.json', size: Buffer.byteLength(conversation) }]
    expect((await validateExport(output, files)).conversations).toBe(1)
    const resolver = fileResolver([{ id: 'first', path: 'wrapped/messages/inbox/a/photos/image.jpg' }, { id: 'second', path: 'wrapped/messages/inbox/b/photos/image.jpg' }])
    expect(resolver('photos/image.jpg', 'wrapped/messages/inbox/a')?.id).toBe('first')
    expect(resolver('image.jpg', 'wrapped/messages/inbox/c')).toBeUndefined()
    expect(resolver('../a/photos/image.jpg', 'wrapped/messages/inbox/b')).toBeUndefined()
  })
  it('streams a highly compressed synthetic 32 MiB entry without buffering its expanded content', async () => {
    const { files } = await extract([{ path: 'large-synthetic.bin', bytes: Buffer.alloc(32 * MiB, 7) }])
    expect(files[0].size).toBe(32 * MiB)
  })
})
