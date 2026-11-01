"""A GTK 3 test window for the agent-desktop benchmark. It logs every key it receives to the file named by KEY_LOG, so
key delivery can be checked on the app side. It is a plain window with an entry and a button, nothing more."""
import os, sys
import gi
gi.require_version('Gtk', '3.0'); gi.require_version('Gdk', '3.0')
from gi.repository import Gtk, Gdk

key_log = os.environ.get('KEY_LOG')
if not key_log:
    sys.exit('Set KEY_LOG to the file the window should log keys to')

# By default the window class is what GTK derives from the script name ("Testapp.py"). APP_CLASS replaces it, so a run can
# give the window a class equal to its process name.
app_class = os.environ.get('APP_CLASS')
if app_class:
    Gdk.set_program_class(app_class)

w = Gtk.Window(title="ADTestApp")
w.set_default_size(480, 260)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin=12)
entry = Gtk.Entry(); entry.set_placeholder_text("Name field")
entry.get_accessible().set_name("Name field")
btn = Gtk.Button(label="Save"); btn.get_accessible().set_name("Save")
box.pack_start(entry, False, False, 0); box.pack_start(btn, False, False, 0)
w.add(box)
log = open(key_log, 'a', buffering=1)
def on_key(widget, event):
    mods = []
    if event.state & Gdk.ModifierType.CONTROL_MASK: mods.append('ctrl')
    if event.state & Gdk.ModifierType.SHIFT_MASK: mods.append('shift')
    log.write('+'.join(mods + [Gdk.keyval_name(event.keyval)]) + '\n')
    return False
w.connect("key-press-event", on_key)
w.connect("destroy", Gtk.main_quit)
w.show_all()
Gtk.main()
