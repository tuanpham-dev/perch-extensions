# Remote Desktop

A Linux X11 desktop inside a Perch tab, streamed as H.264 video with full keyboard, mouse, clipboard and cursor control. In managed mode the desktop is a virtual display that follows the size of your tab, so apps reflow like they would on a real monitor. It is powered by [QuicDesk](https://github.com/tuanpham-dev/quicdesk) (`quicdesk-server`), which captures the screen with shared memory and damage tracking, encodes it in software, and streams it over a WebSocket that Perch's own proxy carries.

Compared with the GUI Apps extension (xpra): a whole screen as one video stream instead of per-window image updates, hardware-decoded in the browser, lower and steadier latency for scrolling, animation and video, one cursor instead of two, and every key reaching the desktop. GUI Apps remains the better fit when you want individual app windows composited into your own desktop.

## The server

`quicdesk-server` ships inside this extension for Linux on x86_64 and arm64, built against glibc 2.28, so it runs on Debian 10, Ubuntu 20.04, RHEL 8 and anything newer. Nothing to install for it. To use your own build instead (another architecture, or a patched server), set `remoteDesktop.serverPath`, or leave the setting empty and put `quicdesk-server` on PATH on a host this package has no binary for:

```sh
git clone https://github.com/tuanpham-dev/quicdesk
cd quicdesk
cargo install --path crates/server
```

Managed mode also needs `Xvfb`, `setxkbmap` and a desktop environment:

```sh
sudo apt install -y xvfb x11-xserver-utils xfce4 dbus-x11
```

## Usage

1. Open the **Remote Desktop** sidebar tab.
2. **Start Remote Desktop**. This runs `quicdesk-server` inside a `remote-desktop` terminal session that shows up like any other session; in managed mode the server brings up the virtual display and the desktop session itself. Open that session to read the server's output, which is also where to look if something fails to start.
3. **Open Display** opens a tab with the live desktop. Click into it and type; it behaves like a screen.
4. Optional: type a command (e.g. `xterm`, `firefox`) and **Launch** to run it on the managed display, in the active project's working directory.
5. **Stop** when done. It ends the session; the server takes the desktop and the display down with it.

Outside Perch, the same managed display is one command:

```sh
quicdesk-server --display :101 --spawn-xvfb --desktop xfce4-session --keyboard-layout us \
  --listen 127.0.0.1:0 --ws-listen 127.0.0.1:14600 --initial-size 1920x1080
```

The tab pauses the stream while it is hidden (another Perch tab active, or the browser tab in the background) and resumes with a fresh keyframe when you return.

## Several viewers: one driver

Any number of tabs or browsers can view the same desktop at once through one shared encoder. The display can only have one size and one scale, so one viewer is the **driver**: the desktop follows its tab size and its pixel ratio. The first viewer drives; every other tab is a follower that shows a banner ("Following another viewer at 2270x1686, scale 2x") with a **Take over** button. A follower sees the driver's picture at the same apparent size, scaled down if its tab is smaller. When the driver leaves, the longest-connected viewer takes the wheel; a driver that reconnects after a Perch restart claims it back.

The desktop scale follows the driver's `remoteDesktop.pixelRatio`: on a managed display the extension sets XFCE's window scaling (2x from ratio 2 up) and font DPI live through xsettings, which GTK apps and XFCE itself pick up at once. Qt and plain Xlib apps only read their scale at startup, so anything started from the **Launch** box gets it through the environment, and apps started earlier keep their old size until relaunched.

## Managed and existing displays

- **Managed** (default): the server starts `Xvfb` on the configured display, applies the keyboard layout and starts the desktop command with a D-Bus session bus of its own, then captures that display. It refuses a display that is already in use. The display resizes to the tab: drag the sidebar or resize the window and the desktop reflows a moment later. Everything the server started ends with it, so **Stop** (or a Perch restart, or the server being killed) leaves no Xvfb or desktop behind.
- **Existing**: the server attaches to a display that already runs, such as `:0` on a desktop machine. Keyboard and mouse go to that real screen. The size is never changed; a screen larger than the tab is scaled down to fit, never up. Launch is not offered in this mode.

## Settings

| Setting | Default | Description |
|---|---|---|
| `remoteDesktop.mode` | `managed` | `managed` starts Xvfb and a desktop; `existing` attaches to a display. |
| `remoteDesktop.display` | `:101` | Display to create (managed) or attach to (existing). |
| `remoteDesktop.desktopCommand` | `xfce4-session` | Managed: the desktop session command. |
| `remoteDesktop.keyboardLayout` | `us` | Managed: XKB layout for the virtual display. |
| `remoteDesktop.port` | `14600` | Preferred loopback port; the next free one is used if taken. |
| `remoteDesktop.fps` | `30` | Capture rate cap. |
| `remoteDesktop.bitrateKbps` | `8000` | Bitrate cap; the stream adapts below it under loss. |
| `remoteDesktop.pixelRatio` | `auto` | Default remote pixels per CSS pixel for all your devices: `auto` (each device's own ratio, capped at 2), `1`, `1.5` or `2`. Any browser can override it for itself from the viewer's pixel-ratio button (stored in that browser only). While a tab drives, the desktop's scale follows its ratio. Higher ratios cost 2 to 4 times the CPU and bandwidth. |
| `remoteDesktop.dpi` | `96` | Managed: DPI reported to apps. |
| `remoteDesktop.serverPath` | empty | Path to your own `quicdesk-server`; empty means the binary shipped with the extension, then PATH, then `~/.cargo/bin`. |

Changes to mode, display, desktop command, layout, fps, bitrate and DPI apply on the next Start. The managed display starts with a 7680x4320 framebuffer, the largest size a tab can request; bigger tabs are scaled. Anything above 4096x2304 is encoded as tiles.

## The viewer tab

- **Keyboard**: keys are forwarded by physical position, including modifiers, function keys and the numeric keypad. Keys held when the tab loses focus are released on the remote side.
- **Mouse**: left, middle and right buttons, both wheel axes; the browser context menu is suppressed over the desktop.
- **Clipboard**: paste in the tab (Ctrl+V or Cmd+V) sends your clipboard text to the desktop before the keystroke, so the remote app pastes it. Text copied inside the desktop is written to your clipboard when the tab has focus; if the browser refuses, the **copy remote clipboard** toolbar button lights up and copies it on click. Text only, up to 1 MB.
- **Cursor**: the pointer shape comes from the desktop (I-beam, resize arrows, busy), drawn as the tab's own cursor, so there is exactly one pointer.
- **View settings** (toolbar, magnifier icon): the pixel ratio this device uses, with the detected value shown, and **Fit the picture to the tab**, which scales a follower's picture up as well as down to fill the tab's width or height with its aspect ratio kept. Both are kept in this browser only, so a phone and a desktop can differ while sharing the synced default. The popover closes on a click outside it or on Escape; a dismissing click on the desktop is not passed to the remote.
- **Stats** (toolbar): remote size and pixel ratio, fps, bitrate, round-trip time, decode time, dropped frames and viewer count, plus a switch to force the software decoder.
- **Fullscreen** (toolbar): real browser fullscreen, and every key goes to the desktop: Perch's own shortcuts (Ctrl+P, Ctrl+Tab, Ctrl+B...) stand down, and in Chromium-based browsers a keyboard lock hands over browser shortcuts like Ctrl+T or Alt+Tab too. Hold Escape to exit. **Ctrl+W still closes the browser tab**, even in fullscreen; browsers keep that one for themselves. Outside fullscreen, Perch's shortcuts keep working as usual.
- **Decoding**: WebCodecs with hardware acceleration where the browser has it. Browsers without WebCodecs (Firefox before 130, older Safari) fall back to a bundled WebAssembly decoder with a banner saying so; it costs more CPU, so a lower pixel ratio helps there.
- **Reconnect**: if the connection drops (a Perch restart, a network blip) the tab keeps the last frame and reconnects with backoff while the session is running.

## Known limitations

- Keyboard forwarding by physical position assumes the desktop's layout matches your keyboard; set `remoteDesktop.keyboardLayout` in managed mode.
- No audio, no file transfer, no image clipboard.
- X11 only; the host needs Xvfb (managed) or an X server (existing). Wayland is not supported.
- Software encoding: 1080p at 30 fps costs about one CPU core on a modern machine. Lower `remoteDesktop.fps` or the pixel ratio on small hosts.
- A cursor created by an X client that has since exited cannot be read from the display (X refuses with BadAccess); the previous shape stays until the next change.
