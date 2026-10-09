export const MiB = 1024 * 1024
export const importLimits = Object.freeze({ chunk: MiB, input: 8 * 1024 * MiB, expanded: 32 * 1024 * MiB,
  entry: 256 * MiB, json: 8 * MiB, entries: 100_000, path: 1024, depth: 32, duration: 30 * 60_000, reserve: 256 * MiB })
export const importErrorCodes = new Set(['import_invalid', 'import_path', 'import_collision', 'import_limit', 'import_disk_full',
  'import_zip_invalid', 'import_zip_encrypted', 'import_zip_method', 'import_zip_special', 'import_integrity',
  'import_cancelled', 'import_timeout', 'import_html_only', 'import_no_messages', 'import_owner_review', 'import_owner_mismatch',
  'import_busy', 'import_incomplete', 'import_interrupted', 'import_cleanup', 'import_storage'])
export function safeImportError(error) {
  return importErrorCodes.has(error?.message) ? error.message : error?.code === 'ENOSPC' ? 'import_disk_full' : 'import_storage'
}
export function logicalPath(value, limits = importLimits) {
  if (typeof value !== 'string' || !value || value.length > limits.path || /[\\\u0000-\u001f\u007f:?#]/.test(value) || value.startsWith('/')) throw new Error('import_path')
  const parts = value.split('/')
  if (parts.length > limits.depth || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new Error('import_path')
  // URL-decoding is used by the viewer's source-reference resolver. Reject any
  // escaped separator/traversal alias here rather than interpreting it twice.
  if (/%(?:2e|2f|5c|00|3a|25)/i.test(value)) throw new Error('import_path')
  return value.normalize('NFC')
}
export function pathRegistry(limits = importLimits) {
  const entries = new Map(), parents = new Set()
  return {
    add(value, directory = false) {
      const path = logicalPath(value, limits), key = path.toLocaleLowerCase('en-US')
      if (entries.has(key) || !directory && parents.has(key)) throw new Error('import_collision')
      const parts = key.split('/')
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/')
        if (entries.get(parent) === false) throw new Error('import_collision')
        parents.add(parent)
      }
      if (entries.size >= limits.entries) throw new Error('import_limit')
      entries.set(key, directory)
      return path
    },
  }
}
