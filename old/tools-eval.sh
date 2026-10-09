#!/usr/bin/env bash
# Evaluate JS inside gnome-shell on the Poco with `ext`, `home`, `Main`, `imports` in scope.
#   ./tools-eval.sh 'return home.get_width()'      or   ./tools-eval.sh < file.js
set -euo pipefail
PHONE=${PHONE:-pulp@192.168.10.98}
code=${1:-$(cat)}
printf '%s' "$code" | ssh "$PHONE" 'cat > /tmp/neo-eval.js; cat > /tmp/neo-eval.py <<"PY"
import gi; gi.require_version("Gio","2.0")
from gi.repository import Gio, GLib
p = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, 0, None, "org.gnome.Shell", "/de/yesman/NeoLauncher", "de.yesman.NeoLauncher", None)
print(p.call_sync("Eval", GLib.Variant("(s)", (open("/tmp/neo-eval.js").read(),)), 0, -1, None)[0])
PY
sudo asuser python3 /tmp/neo-eval.py'
