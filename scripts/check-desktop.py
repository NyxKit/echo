#!/usr/bin/env python3
"""Exercise the real controller on a private D-Bus session and disposable roots."""
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from gi.repository import Gio, GLib

node = sys.argv[1]
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
registrations = []
xml = "<node><interface name='org.kde.StatusNotifierWatcher'><method name='RegisterStatusNotifierItem'><arg type='s' direction='in'/></method></interface></node>"
info = Gio.DBusNodeInfo.new_for_xml(xml)
def method(connection, caller, path, interface, name, parameters, invocation):
    registrations.append(parameters.unpack()[0])
    invocation.return_value(None)
bus.register_object('/StatusNotifierWatcher', info.interfaces[0], method, None, None)
bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', GLib.Variant('(su)', ('org.kde.StatusNotifierWatcher', 0)), None, Gio.DBusCallFlags.NONE, 1000, None)
threading.Thread(target=loop.run, daemon=True).start()
def wait(predicate, timeout=20):
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, 'Synthetic desktop check timed out'
        time.sleep(.05)
def call(name, parameters):
    return bus.call_sync(registrations[-1], '/Menu', 'com.canonical.dbusmenu', name, parameters, None, Gio.DBusCallFlags.NONE, 2000, None).unpack()
def status():
    return call('GetProperty', GLib.Variant('(is)', (1, 'label')))[0]
def click(item):
    call('Event', GLib.Variant('(isvu)', (item, 'clicked', GLib.Variant('s', ''), 0)))
with tempfile.TemporaryDirectory(prefix='echo-synthetic-desktop-') as root:
    root = Path(root)
    runtime = root / 'state' / 'echo'
    runtime.mkdir(parents=True, mode=0o700)
    binary = root / 'bin'; binary.mkdir()
    opener = binary / 'xdg-open'
    opener.write_text('#!/bin/sh\nprintf x >> "$ECHO_SYNTHETIC_OPENS"\n')
    opener.chmod(0o700)
    opened = root / 'opened'
    env = dict(os.environ, XDG_STATE_HOME=str(root/'state'), XDG_DATA_HOME=str(root/'library'), XDG_CONFIG_HOME=str(root/'config'), PATH=str(binary)+':'+os.environ['PATH'], ECHO_SYNTHETIC_OPENS=str(opened))
    occupied = socket.socket(); occupied.bind(('127.0.0.1', 0)); occupied.listen()
    portfile = runtime/'port.json'; portfile.write_text(json.dumps(dict(version=1, port=occupied.getsockname()[1]))); portfile.chmod(0o600)
    controller = subprocess.Popen([node, 'server/desktop.mjs', '--controller-open'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait(lambda: len(registrations) == 1)
        wait(lambda: 'port' in status().lower())
        assert not opened.exists()
        occupied.close()
        click(2)
        wait(lambda: status() == 'Echo is running' and opened.exists())
        assert opened.read_text() == 'x'
        subprocess.run([node, 'server/desktop.mjs', '--open'], env=env, check=True, timeout=15)
        wait(lambda: opened.read_text() == 'xx')
        assert len(registrations) == 1
        children = Path(f'/proc/{controller.pid}/task/{controller.pid}/children').read_text().split()
        hosts = [int(pid) for pid in children if b'/server/host.mjs' in Path(f'/proc/{pid}/cmdline').read_bytes()]
        assert len(hosts) == 1
        os.kill(hosts[0], signal.SIGKILL)
        wait(lambda: 'unavailable' in status().lower())
        click(2)
        wait(lambda: status() == 'Echo is running' and opened.read_text() == 'xxx')
        click(3)
        login = root/'config'/'autostart'/'echo.desktop'
        wait(lambda: login.exists())
        assert '--login' in login.read_text()
        click(3); wait(lambda: not login.exists())
        click(4); assert controller.wait(timeout=15) == 0
        controller = subprocess.Popen([node, 'server/desktop.mjs', '--login'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait(lambda: len(registrations) == 2)
        wait(lambda: status() == 'Echo is running')
        assert opened.read_text() == 'xxx'
        subprocess.run([node, 'server/cli.mjs', 'quit'], env=env, check=True, stdout=subprocess.DEVNULL, timeout=15)
        assert controller.wait(timeout=10) == 0
        # Exercise the actual desktop entry without an available native helper.
        # This copy contains only application code and dependencies, never a
        # repository root, user profile or existing library.
        fallback = root / 'without-tray'; fallback.mkdir()
        for name in ['server', 'shared', 'dist']:
            shutil.copytree(name, fallback / name)
        (fallback / 'node_modules').symlink_to(Path('node_modules').resolve(), target_is_directory=True)
        subprocess.run([node, str(fallback/'server'/'desktop.mjs'), '--open'], env=env, check=True, timeout=20)
        assert opened.read_text() == 'xxxx', 'Desktop launch must open the browser when the tray helper is missing'
        subprocess.run([node, 'server/cli.mjs', 'status'], env=env, check=True, stdout=subprocess.DEVNULL, timeout=15)
        subprocess.run([node, 'server/cli.mjs', 'quit'], env=env, check=True, stdout=subprocess.DEVNULL, timeout=15)
        # A present helper without a usable session bus must also leave the
        # browser/server path working, with exactly one browser opening.
        no_bus = dict(env, DBUS_SESSION_BUS_ADDRESS='unix:path=/nonexistent-echo-synthetic-session')
        subprocess.run([node, 'server/desktop.mjs', '--open'], env=no_bus, check=True, timeout=20)
        assert opened.read_text() == 'xxxxx'
        subprocess.run([node, 'server/cli.mjs', 'status'], env=env, check=True, stdout=subprocess.DEVNULL, timeout=15)
        subprocess.run([node, 'server/cli.mjs', 'quit'], env=env, check=True, stdout=subprocess.DEVNULL, timeout=15)
        occupied = socket.socket(); occupied.bind(('127.0.0.1', 0)); occupied.listen()
        portfile.write_text(json.dumps(dict(version=1, port=occupied.getsockname()[1])))
        failed = subprocess.run([node, 'server/desktop.mjs', '--open'], env=env, capture_output=True, text=True, timeout=20)
        assert failed.returncode == 1 and 'port is occupied' in failed.stderr
        wait(lambda: len(registrations) == 3)
        wait(lambda: 'port is occupied' in status())
        assert opened.read_text() == 'xxxxx'
        occupied.close()
        click(2); wait(lambda: opened.read_text() == 'xxxxxx' and status() == 'Echo is running')
        click(4)
        wait(lambda: not (runtime/'instance.json').exists())
        print('Synthetic desktop checks passed: occupied-port recovery, single tray, browser opening, crash/retry, opt-in login setting, background login, tray Quit, external Quit removes tray, and missing-helper/unavailable-bus fallback.')
    finally:
        occupied.close()
        subprocess.run([node, 'server/cli.mjs', 'quit'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        if controller.poll() is None:
            controller.terminate(); controller.wait(timeout=5)
        loop.quit()
