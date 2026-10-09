import { spawnSync } from 'node:child_process'
if (process.platform !== 'linux') throw new Error('This private D-Bus controller check requires Linux')
const result = spawnSync('dbus-run-session', ['--', '/usr/bin/python3', 'scripts/check-desktop.py', process.execPath], { stdio: 'inherit' })
if (result.error) throw new Error('The desktop check requires D-Bus and Python GObject introspection')
process.exitCode = result.status ?? 1
