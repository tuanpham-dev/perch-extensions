#!/usr/bin/env bash
# Starts everything a Remote Desktop session needs inside one terminal
# window, so the streaming port belongs to that session's process tree (the
# core proxy only forwards ports it can attribute to a terminal).
#
# Usage: launch.sh <managed|existing> <display> <port> <fps> <bitrate_bps> <dpi> \
#                  <layout> <desktop_command> <server_path> <initial_size> <runtime_dir> \
#                  <apply_scale_script>
#
# Managed: Xvfb + keyboard layout + desktop session + quicdesk-server.
# Existing: quicdesk-server only, attached to the given display.
# Child PIDs are written to <runtime_dir>/pids so server.js can finish the
# cleanup if this shell dies without running its trap.
set -u

MODE=$1; DISPLAY_NAME=$2; PORT=$3; FPS=$4; BITRATE=$5; DPI=$6
LAYOUT=$7; DESKTOP_CMD=$8; SERVER=$9; INITIAL_SIZE=${10}; RUNTIME_DIR=${11}; APPLY_SCALE=${12:-}
PIDS="$RUNTIME_DIR/pids"
# The largest display a tab may ask for (8K); the server tiles anything
# above one encoder's 4096x2304.
XVFB_FRAMEBUFFER="7680x4320x24"

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"
: > "$PIDS"

# Entries are PIDs, or "-PGID" for a whole process group: the desktop
# session is started under setsid because dbus-launch forks it away from this
# shell, so killing dbus-launch alone leaves the desktop running.
targets=()
cleanup() {
  trap - EXIT INT TERM HUP
  local t
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  for t in "${targets[@]}"; do
    kill -TERM -- "$t" 2>/dev/null
  done
  sleep 1
  for t in "${targets[@]}"; do
    kill -KILL -- "$t" 2>/dev/null
  done
  rm -f "$PIDS"
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM HUP

track() { targets+=("$1"); echo "$1" >> "$PIDS"; }

if [ "$MODE" = "managed" ]; then
  if ! command -v Xvfb >/dev/null; then
    echo "Xvfb is not installed (apt install xvfb)" >&2
    exit 1
  fi
  sock="/tmp/.X11-unix/X${DISPLAY_NAME#:}"
  # A socket file alone proves nothing: a killed Xvfb leaves it behind.
  # Only a server that answers counts as "in use"; a stale socket and lock
  # are cleared so Xvfb can bind.
  if [ -S "$sock" ] && xdpyinfo -display "$DISPLAY_NAME" >/dev/null 2>&1; then
    echo "display $DISPLAY_NAME is already in use; pick another in Settings" >&2
    exit 1
  fi
  rm -f "$sock" "/tmp/.X${DISPLAY_NAME#:}-lock" 2>/dev/null
  Xvfb "$DISPLAY_NAME" -screen 0 "$XVFB_FRAMEBUFFER" +extension RANDR -noreset -nolisten tcp -dpi "$DPI" &
  track $!
  for _ in $(seq 1 40); do
    [ -S "$sock" ] && break
    sleep 0.25
  done
  if [ ! -S "$sock" ]; then
    echo "Xvfb did not create $DISPLAY_NAME" >&2
    exit 1
  fi
  export DISPLAY="$DISPLAY_NAME"
  # A desktop session expects a runtime dir it can write to; the server
  # that started us may have none.
  if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ ! -w "${XDG_RUNTIME_DIR:-/nonexistent}" ]; then
    export XDG_RUNTIME_DIR="$RUNTIME_DIR/xdg"
    mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
  fi
  command -v setxkbmap >/dev/null && setxkbmap -display "$DISPLAY_NAME" "$LAYOUT" 2>/dev/null
  # One session bus for the desktop and for the scale hook, so xfconf
  # changes made by the hook reach the running desktop.
  if command -v dbus-launch >/dev/null; then
    eval "$(dbus-launch --sh-syntax)"
    export DBUS_SESSION_BUS_ADDRESS
    [ -n "${DBUS_SESSION_BUS_PID:-}" ] && track "$DBUS_SESSION_BUS_PID"
  fi
  setsid bash -c "$DESKTOP_CMD" &
  # setsid makes that child a session and group leader: its PID is the PGID.
  track "-$!"
  scale_args=()
  if [ -n "$APPLY_SCALE" ] && [ -f "$APPLY_SCALE" ]; then
    scale_args=(--on-scale "bash '$APPLY_SCALE'")
  fi
  "$SERVER" --display "$DISPLAY_NAME" --listen 127.0.0.1:0 --ws-listen "127.0.0.1:$PORT" \
    --allow-resize --initial-size "$INITIAL_SIZE" --fps "$FPS" --bitrate "$BITRATE" "${scale_args[@]}" &
  SERVER_PID=$!
else
  "$SERVER" --display "$DISPLAY_NAME" --listen 127.0.0.1:0 --ws-listen "127.0.0.1:$PORT" \
    --fps "$FPS" --bitrate "$BITRATE" &
  SERVER_PID=$!
fi

wait "$SERVER_PID"
status=$?
echo "quicdesk-server exited with status $status"
exit $status
