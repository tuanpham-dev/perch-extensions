#!/usr/bin/env bash
# Scale hook for quicdesk-server (--on-scale): makes the managed desktop
# match the driver's pixel ratio. SCALE, DISPLAY and the desktop's
# DBUS_SESSION_BUS_ADDRESS come from the server, so xfconf reaches the
# running desktop.
#
# GTK 3 and 4 and XFCE itself follow xsettings live: an integer window
# scale (2 from ratio 2 up) plus fonts at the remaining fraction through
# Xft DPI. Plain Xlib apps read Xft.dpi from the resource database at
# startup, so it is set there too. Qt apps take their factor from the
# environment when launched (see server.js's launch command).
set -u
scale=${SCALE:-1}
gdk=1
awk "BEGIN { exit !($scale >= 2) }" && gdk=2
dpi=$(awk "BEGIN { printf \"%d\", 96 * $scale / $gdk + 0.5 }")
if command -v xfconf-query >/dev/null 2>&1 && [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  xfconf-query -c xsettings -p /Gdk/WindowScalingFactor -n -t int -s "$gdk" 2>/dev/null
  xfconf-query -c xsettings -p /Xft/DPI -n -t int -s "$dpi" 2>/dev/null
fi
if command -v xrdb >/dev/null 2>&1; then
  printf 'Xft.dpi: %s\n' "$(awk "BEGIN { printf \"%d\", 96 * $scale + 0.5 }")" | xrdb -merge 2>/dev/null
fi
exit 0
