import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function run(command, args, input) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'] })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Synthetic Linux distribution check failed')))
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input) }
  })
}

if (process.argv.includes('--inside')) {
  assert.equal(process.env.ECHO_SYNTHETIC_PACKAGE, '1')
  assert.notEqual(process.getuid(), 0, 'Package acceptance must run unprivileged')
  const release = await readFile('/etc/os-release', 'utf8')
  console.log(release.match(/^PRETTY_NAME="([^"]+)"/m)?.[1] ?? 'Linux distribution')
  await run('getconf', ['GNU_LIBC_VERSION'])
  await run('/work/package/native/echo-host', ['--probe'])
  await run(process.execPath, ['/checks/check-linux-package.mjs', '/work/package'])
  await run('dbus-run-session', ['--', '/usr/bin/python3', '/checks/check-desktop.py', process.execPath])
} else {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() === 0) throw new Error('Run this check as an unprivileged user on x86-64 Linux with Docker')
  const versions = process.argv.length > 2 ? process.argv.slice(2) : ['22.04', '24.04']
  if (versions.some(version => !['22.04', '24.04'].includes(version))) throw new Error('Supported check arguments: 22.04 24.04')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const scratch = await mkdtemp(join(tmpdir(), 'echo-synthetic-linux-distribution-'))
  try {
    await run('tar', ['-xzf', join(root, 'release', `Echo-${metadata.version}-linux-x64.tar.gz`), '-C', scratch])
    for (const version of versions) {
      const image = 'echo-synthetic-linux-package:' + version
      const glib = version === '22.04' ? 'libglib2.0-0' : 'libglib2.0-0t64'
      // Docker receives only this public Dockerfile through stdin, with no
      // build context containing source, exports, profiles or credentials.
      await run('docker', ['build', '--tag', image, '--build-arg', `ECHO_CHECK_UID=${process.getuid()}`, '--build-arg', `ECHO_CHECK_GID=${process.getgid()}`, '-'],
        `FROM ubuntu:${version}\nRUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ${glib} libstdc++6 util-linux xdg-utils dbus python3 python3-gi passwd && rm -rf /var/lib/apt/lists/*\nARG ECHO_CHECK_UID\nARG ECHO_CHECK_GID\nRUN getent group "$ECHO_CHECK_GID" >/dev/null || groupadd --gid "$ECHO_CHECK_GID" echo-check\nRUN getent passwd "$ECHO_CHECK_UID" >/dev/null || useradd --no-log-init --uid "$ECHO_CHECK_UID" --gid "$ECHO_CHECK_GID" --no-create-home --home-dir /tmp/echo-synthetic-home echo-check\n`)
      const args = ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--user', `${process.getuid()}:${process.getgid()}`, '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g', '--workdir', '/work/package',
        '--env', 'ECHO_SYNTHETIC_PACKAGE=1', '--mount', `type=bind,source=${scratch},target=/work/package,readonly`]
      for (const name of ['check-linux-container.mjs', 'check-linux-package.mjs', 'check-desktop.py']) {
        args.push('--mount', `type=bind,source=${join(root, 'scripts', name)},target=/checks/${name},readonly`)
      }
      args.push(image, '/work/package/runtime/node', '/checks/check-linux-container.mjs', '--inside')
      await run('docker', args)
      console.log(`Ubuntu ${version}: unprivileged offline package and controller checks passed.`)
    }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
