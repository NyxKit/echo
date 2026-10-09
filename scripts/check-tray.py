#!/usr/bin/env python3
"""Synthetic private-session D-Bus contract check; run under dbus-run-session."""
import os
import subprocess
import threading
import time
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
registered = threading.Event()
sender = None
xml = "<node><interface name='org.kde.StatusNotifierWatcher'><method name='RegisterStatusNotifierItem'><arg type='s' direction='in'/></method></interface></node>"
info = Gio.DBusNodeInfo.new_for_xml(xml)
def method(connection, caller, path, interface, name, parameters, invocation):
    global sender
    sender = parameters.unpack()[0]
    invocation.return_value(None)
    registered.set()
bus.register_object('/StatusNotifierWatcher', info.interfaces[0], method, None, None)
bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
              GLib.Variant('(su)', ('org.kde.StatusNotifierWatcher', 0)), None, Gio.DBusCallFlags.NONE, 1000, None)
thread = threading.Thread(target=loop.run, daemon=True)
thread.start()
process = subprocess.Popen(['build/echo-host'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
def call(name, parameters):
    return bus.call_sync(sender, '/Menu', 'com.canonical.dbusmenu', name, parameters, None, Gio.DBusCallFlags.NONE, 2000, None).unpack()
try:
    assert registered.wait(5)
    assert process.stdout.readline().strip() == 'ready'
    revision, layout = call('GetLayout', GLib.Variant('(iias)', (0, -1, [])))
    assert layout[0] == 0
    assert len(layout[2]) == 4
    assert call('GetProperty', GLib.Variant('(is)', (3, 'toggle-state')))[0] == 0
    process.stdin.write('autostart 1\nstatus Synthetic running\n')
    process.stdin.flush()
    deadline = time.monotonic() + 2
    while call('GetProperty', GLib.Variant('(is)', (3, 'toggle-state')))[0] != 1:
        assert time.monotonic() < deadline
        time.sleep(.01)
    assert call('GetProperty', GLib.Variant('(is)', (1, 'label')))[0] == 'Synthetic running'
    for item, expected in [(2, 'open'), (3, 'autostart'), (4, 'quit')]:
        call('Event', GLib.Variant('(isvu)', (item, 'clicked', GLib.Variant('s', ''), 0)))
        assert process.stdout.readline().strip() == expected
    process.stdin.close()
    assert process.wait(timeout=3) == 0
    assert not process.stderr.read()
    print('Synthetic tray protocol checks passed: menu, status, login checkbox, actions, and EOF shutdown.')
finally:
    if process.poll() is None:
        process.kill()
    process.wait()
    loop.quit()
