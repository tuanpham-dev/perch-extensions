# Remote Desktop

A Linux desktop inside a Perch tab, streamed as low-latency video with full keyboard, mouse, clipboard, cursor and audio. In managed mode the desktop is a virtual display that follows the size and scale of your tab, so apps reflow like they would on a real monitor; in existing mode it attaches to the desktop already running on the machine, Wayland or X11. It is powered by [QuickRemote](https://github.com/tuanpham-dev/quick-remote) (`qr-host`), which captures the screen without a copy, encodes on the GPU where there is one (VA-API H.264 and H.265, AV1 on hardware that has it) and in software otherwise, and serves Perch over a loopback WebSocket that Perch's own proxy carries.

Compared with the GUI Apps extension (xpra): a whole screen as one video stream instead of per-window image updates, hardware-decoded in the browser, lower and steadier latency for scrolling, animation and video, one cursor instead of two, and every key reaching the desktop. GUI Apps remains the better fit when you want individual app windows composited into your own desktop.

## The engine

`qr-host` is not inside this package: it links the host's GStreamer, so it comes as a release build instead. Open the **Remote Desktop** sidebar tab and click **Download qr-host**. The extension fetches the latest release for your machine (Linux x86_64 or arm64, built against Debian 12's libraries, so Debian 12 and newer and Ubuntu 24.04 and newer run it), checks it against the release's `SHA256SUMS`, and keeps it in `~/.local/share/perch-remote-desktop/`. When a newer version is required the button becomes **Update**.

To use your own build instead (another distribution, or a patched host), set `remoteDesktop.serverPath`, or leave the setting empty and put `qr-host` on PATH or in `~/.cargo/bin`:

```sh
git clone https://github.com/tuanpham-dev/quick-remote
cd quick-remote
cargo install --path crates/qr-host
```

The host needs these packages. Managed mode needs sway, Xwayland, xdg-desktop-portal-wlr (the host captures the display through it), PipeWire, WirePlumber and a desktop; the GStreamer plugins carry the encoders:

```sh
sudo apt install -y sway xwayland xdg-desktop-portal-wlr pipewire wireplumber xfce4 dbus-x11 \
  gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-pipewire
```

For GPU rendering and encoding the user running Perch needs the `render` group (`sudo usermod -aG render $USER`, then log in again) and a VA-API driver (`intel-media-va-driver-non-free` for Intel, `mesa-va-drivers` for AMD). Without a usable render node the virtual display renders in software and x264 encodes on the CPU; the panel says which. `qr-host --probe` lists the encoders the host found.

## Usage

1. Open the **Remote Desktop** sidebar tab. Download the engine if the panel asks for it.
2. **Start Remote Desktop**. This runs `qr-host` inside a `remote-desktop` terminal session that shows up like any other session; in managed mode the host brings up the virtual display and the desktop itself. Open that session to read the host's output, which is also where to look if something fails to start.
3. **Open Display** opens a tab with the live desktop. Click into it and type; it behaves like a screen.
4. Optional: type a command (e.g. `xterm`, `firefox`) and **Launch** to run it on the managed display, in the active project's working directory.
5. **Stop** when done. It ends the session; the host takes the desktop and the display down with it.

Outside Perch, the same managed desktop is one command:

```sh
qr-host --source vdisplay --desktop xfce4-session --keyboard-layout us --dpi 96 \
  --listen 127.0.0.1:0 --ws-listen 127.0.0.1:14600 --no-mdns
```

The tab pauses the stream while it is hidden (another Perch tab active, or the browser tab in the background) and resumes with a fresh keyframe when you return.

## Several viewers: one driver

Any number of tabs or browsers can view the same desktop at once through one shared session. The display can only have one size and one scale, so one viewer is the **driver**: the desktop follows its size (or its fixed resolution) and its pixel ratio. The first viewer drives; every other tab is a follower that shows a banner ("Following another viewer at 2270x1686, scale 2x") with a **Take over** button. A follower sees the driver's picture, shrunk to fit its tab, or filled or at 100% from its own view settings. When the driver leaves, the longest-connected viewer takes the wheel; a driver that reconnects after a Perch restart claims it back. Every viewer can type and click.

The desktop scale follows the driver's pixel ratio: on a managed display the host sets the virtual display's output scale and XFCE's window scaling and font DPI to match, which GTK apps and XFCE pick up at once. Qt and plain Xlib apps only read their scale at startup, so anything started from the **Launch** box gets it through the environment, and apps started earlier keep their old size until relaunched.

## Managed and existing displays

- **Managed** (default): the host starts a headless sway on the GPU (or in software), a rootful Xwayland inside it with the keyboard layout and DPI applied, and the desktop command on that; then it captures the display. The display resizes to the tab: drag the sidebar or resize the window and the desktop reflows a moment later. Everything the host started ends with it, so **Stop** (or a Perch restart, or the host being killed) leaves no sway, Xwayland or desktop behind. `remoteDesktop.renderer` picks GPU or software rendering; `auto` uses the GPU when a render node is usable.
- **Existing**: the host attaches to the desktop that already runs: a Wayland session (KDE through KWin's screencast, GNOME through mutter's remote desktop, sway and other wlroots compositors through screencopy) or an X display. Keyboard and mouse go to that real screen; Wayland input needs `/dev/uinput` access (the `input` group and QuickRemote's udev rule). The size is never changed; a screen larger than the tab is scaled down to fit. Set `remoteDesktop.display` to force an X display such as `:0`. Launch is not offered in this mode.

## Settings

| Setting | Default | Description |
|---|---|---|
| `remoteDesktop.mode` | `managed` | `managed` starts a virtual display and a desktop; `existing` attaches to the running one. |
| `remoteDesktop.display` | empty | Existing mode: an X display to force (`:0`); empty detects the running desktop. |
| `remoteDesktop.desktopCommand` | `xfce4-session` | Managed: the desktop session command. |
| `remoteDesktop.useGlobalConfig` | `false` | Managed: run the desktop with your own `~/.config` instead of a fresh config directory each Start, so your XFCE theme, panel and window manager settings apply and changes persist (qr-host 0.2.1+, `--desktop-user-config`). |
| `remoteDesktop.keyboardLayout` | `us` | Managed: XKB layout for the virtual display. |
| `remoteDesktop.renderer` | `auto` | Managed: `gpu`, `software` or `auto` (GPU when a render node is usable). |
| `remoteDesktop.port` | `14600` | Preferred loopback port; the next free one is used if taken. |
| `remoteDesktop.fps` | `60` | Frame rate cap. |
| `remoteDesktop.bitrateKbps` | `40000` | Upper bitrate limit; the stream adapts below it, and the viewer's quality preset caps it further. |
| `remoteDesktop.codec` | `auto` | `auto` (H.264, which every browser decodes), `h264`, `h265` or `av1`. All viewers share one stream, so each viewing browser must decode the codec chosen; one that can't shows "No common codec" (qr-host 0.2.1+ for anything but `auto`). |
| `remoteDesktop.pixelRatio` | `auto` | Default remote pixels per CSS pixel for all your devices: `auto` (each device's own ratio, capped at 2), `1`, `1.5` or `2`. Any browser can override it for itself from the viewer's view settings (stored in that browser only). While a tab drives, the desktop's scale follows its ratio. Higher ratios cost 2 to 4 times the CPU and bandwidth. |
| `remoteDesktop.dpi` | `96` | Managed: font DPI reported to apps. |
| `remoteDesktop.serverPath` | empty | Path to your own `qr-host`; empty means the downloaded binary, then PATH, then `~/.cargo/bin`. |

Changes to mode, display, desktop command, global config, layout, renderer, fps, bitrate, codec and DPI apply on the next Start. A tab larger than the encoder takes (4096 pixels wide on most hardware encoders) gets the largest size that fits, with the scale lowered so the desktop keeps its logical size; the stats panel shows the host's note.

## The viewer tab

- **Keyboard**: keys are forwarded by physical position, including modifiers, function keys and the numeric keypad. Keys held when the tab loses focus are released on the remote side.
- **Phone keyboard**: on a touch device the toolbar has a keyboard button. It opens the phone's keyboard, and what you type is typed on the desktop as text, so accents, emoji and other scripts arrive as written whatever the desktop's layout. A strip of extra keys comes with it: Esc, Tab, the arrows, Home, End, PgUp, PgDn, and sticky Ctrl, Alt and Super that apply to the next key. While the keyboard is up the picture fits above it and the desktop keeps its size, so apps do not reflow each time it opens.
- **Mouse and touch**: left, middle and right buttons, both wheel axes; the browser context menu is suppressed over the desktop. On a touch screen: tap = click, long press or two-finger tap = right click, three-finger tap = middle click, one-finger drag = drag, two-finger drag = scroll (pan while zoomed in), pinch = zoom, four-finger tap = the phone keyboard. Two quick taps on about the same spot land on the same remote pixel, so they make a double click. **Trackpad** (view settings, Touch) makes one finger move the pointer like a trackpad instead: tap to click where it is, tap and then touch again and move to drag, long press for a right click; the desktop's pointer is drawn on the picture so you can see it. Two-finger scroll, pinch and the other taps are the same in both modes.
- **View settings** (toolbar, gear icon): the display **size** this tab asks for while it drives (follow the tab, or a fixed resolution from the presets or a custom size, with a refresh rate), the **pixel ratio** this device uses with the detected value shown, the **view** (Fit shrinks a large picture and never enlarges it; Fill fills the tab with the aspect ratio kept; 100% is one remote pixel per device pixel), and the **quality** preset (High, Medium or Low caps the bitrate at 100%, 40% or 15%). All of it is kept in this browser only, so a phone and a desktop can differ while sharing the synced default.
- **Zoom** (view settings): Ctrl+wheel, a pinch, or the − and + buttons in the view settings popover, from 25% to 400%; the percentage button goes back to 100%. **Lock zoom** there makes a pinch or Ctrl+wheel change nothing, for a phone held in one hand; the buttons still work. A zoomed picture pans when the mouse nears an edge or when two fingers drag it.
- **Audio**: the speaker button plays the desktop's sound in the tab (Opus, decoded with WebCodecs). It is off until clicked, and the choice is kept in this browser.
- **Clipboard**: paste in the tab (Ctrl+V or Cmd+V) sends your clipboard, text or a PNG image, to the desktop before the keystroke, so the remote app pastes it. Text or an image copied inside the desktop is written to your clipboard when the tab has focus; if the browser refuses, the **copy remote clipboard** toolbar button lights up and copies it on click. Up to 16 MB.
- **Files**: drop a file on the desktop to send it to the host's `~/Downloads/QuickRemote`; a file placed in the host's `~/QuickRemote/Outbox` downloads in the browser. Both show their progress in the tab.
- **Cursor**: on X11 displays and the managed desktop the pointer shape comes from the desktop (I-beam, resize arrows, busy), drawn as the tab's own cursor, so there is exactly one pointer. On KDE, GNOME and wlroots desktops the pointer is part of the picture and the browser pointer is hidden over it.
- **Stats** (toolbar): remote size and pixel ratio, codec and encoder, fps, bitrate, round-trip time, decode time, frames the decoder had to drop, viewer count, zoom and audio.
- **Fullscreen** (toolbar): real browser fullscreen, and every key goes to the desktop: Perch's own shortcuts (Ctrl+P, Ctrl+Tab, Ctrl+B...) stand down, and in Chromium-based browsers a keyboard lock hands over browser shortcuts like Ctrl+T or Alt+Tab too. Hold Escape to exit. **Ctrl+W still closes the browser tab**, even in fullscreen; browsers keep that one for themselves. Outside fullscreen, Perch's shortcuts keep working as usual.
- **Decoding**: WebCodecs, with hardware acceleration where the browser has it. The tab tells the host which codecs the browser decodes (AV1, H.265, H.264) and the host encodes the best one both sides have; the stats panel names it. A browser without WebCodecs (Firefox before 130, Safari before 16.4) sees a banner and no stream.
- **Reconnect**: if the connection drops (a Perch restart, a network blip) the tab keeps the last frame and reconnects with backoff while the session is running.

## Known limitations

- Keyboard forwarding by physical position assumes the desktop's layout matches your keyboard; set `remoteDesktop.keyboardLayout` in managed mode.
- No microphone, gamepads or pen from the browser (QuickRemote's native and Android clients have them).
- The cursor stays in the picture on Wayland desktops in existing mode; those compositors give no third party the pointer image.
- One native or WebTransport client and Perch's viewers cannot share a host at the same time: whichever connects second is refused as busy.
- Software encoding: 1080p at 30 fps costs about one CPU core on a modern machine. Lower `remoteDesktop.fps`, the quality preset or the pixel ratio on small hosts.

## When something is off

The host's log is in `~/.local/share/perch-remote-desktop/host.log`, truncated on each Start. It records the rate controller's decisions (why the frame rate or bit budget changed) and the input it injects: every button and wheel event, typed text, and pointer moves while a button is held. To report a gesture or a drag that went wrong, do it once and send the lines from that moment.
