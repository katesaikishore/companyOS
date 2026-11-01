import gi, sys
gi.require_version('Gtk', '3.0'); gi.require_version('Gdk', '3.0')
from gi.repository import Gtk, Gdk
w = Gtk.Window(title="ADTestApp")
w.set_default_size(480, 260)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin=12)
entry = Gtk.Entry(); entry.set_placeholder_text("Name field")
entry.get_accessible().set_name("Name field")
btn = Gtk.Button(label="Save"); btn.get_accessible().set_name("Save")
box.pack_start(entry, False, False, 0); box.pack_start(btn, False, False, 0)
w.add(box)
log = open('/home/user/e2e-logs/ad/keys.log', 'a', buffering=1)
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
