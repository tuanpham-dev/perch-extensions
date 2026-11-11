# Remote Desktop

A Linux desktop inside a Perch tab, streamed as low-latency video with full keyboard, mouse, clipboard, files, cursor and audio. In managed mode the desktop is a virtual display that follows the size and scale of your tab, so apps reflow like they would on a real monitor; in existing mode it attaches to the desktop already running on the machine (X11, a wlroots compositor such as sway, GNOME or KDE Plasma). It is powered by [remote-pc](https://github.com/tuanpham-dev/remote-pc-releases)'s host, `rpc-host`, which encodes on the GPU with VA-API (H.264 and H.265), or on a machine without a usable GPU on the CPU with OpenH264 (H.264, up to 3840x2160 at 30 fps), and serves Perch over a loopback WebSocket that Perch's own proxy carries.

Compared with the GUI Apps extension (xpra): a whole screen as one video stream instead of per-window image updates, hardware-decoded in the browser, lower and steadier latency for scrolling, animation and video, one cursor instead of two, and every key reaching the desktop. GUI Apps remains the better fit when you want individual app windows composited into your own desktop.

## The engine

`rpc-host` is not inside this package; it comes as a release build. Open the **Remote Desktop** sidebar tab and click **Download rpc-host**. The extension fetches the latest release from [remote-pc-releases](https://github.com/tuanpham-dev/remote-pc-releases/releases) (Linux x86_64, built on Debian 13, or arm64, e.g. an Oracle Cloud Ampere machine, which has no GPU: there rpc-host encodes and renders on the CPU), checks it against the release's `SHA256SUMS`, and unpacks it into `~/.local/share/perch-remote-desktop/rpc-host/`. It holds `bin/rpc-host` and (x86_64) a patched wlroots for its headless sway (frames on time, about 13 ms less latency; rpc-host uses it when it suits the installed sway, Debian 13's sway 1.10). When this extension needs a newer engine the button becomes **Update**; and whenever a newer release is out (looked up every 6 hours, or with **Check for updates**) the panel offers **Update to …** for the downloaded engine, also while a desktop runs (the new one runs from the next Start).

To use another build, set `remoteDesktop.serverPath`, or leave it empty and put `rpc-host` on PATH or in `~/.cargo/bin`. An older rpc-host build without the options this extension runs it with (a machine's own host service installed earlier, say) is passed over, and the panel says so.

The host needs these packages (Debian and Ubuntu names). Managed mode needs sway, Xwayland, xdg-desktop-portal-wlr, PipeWire, WirePlumber and a desktop:

```sh
sudo apt install -y sway xwayland xdg-desktop-portal-wlr pipewire wireplumber pipewire-pulse xfce4 \
  libva2 libva-drm2 mesa-va-drivers
```

Without a GPU encoder (or render node) the host falls back to the CPU by itself: the panel shows `openh264` and software rendering. For the GPU the user running Perch needs the `render` group (`sudo usermod -aG render $USER`, then log in again) and a VA-API driver that encodes (`mesa-va-drivers` for AMD, `intel-media-va-driver-non-free` for Intel). `vainfo` should list `VAEntrypointEncSlice` for H.264 or HEVC.

## Usage

1. Open the **Remote Desktop** sidebar tab. Download the engine if the panel asks for it.
2. **Start Remote Desktop**. This runs `rpc-host` inside a `remote-desktop` terminal session that shows up like any other session; in managed mode the host brings up the virtual display and the desktop itself. Open that session to read the host's output if something fails to start.
3. **Open Display** opens a tab with the live desktop. Click into it and type; it behaves like a screen.
4. Optional: type a command (e.g. `xterm`, `firefox`) and **Launch** to run it on the managed display.
5. **Stop** when done. The host takes the desktop and the display down with it.

The tab pauses the stream while it is hidden (another Perch tab active, or the browser tab in the background) and resumes with a fresh keyframe when you return. After a Stop and Start, open tabs reconnect by themselves.

## Several viewers: one driver

Any number of tabs or browsers can view the same desktop at once. One viewer is the **driver**: the desktop follows its size and pixel ratio, and only its keyboard and mouse reach the desktop. Every other tab is a follower: it shows a banner ("Following <who> at <size>…") with a **Take over** button, watches a lighter stream of the same picture (at most 1920×1080 worth of pixels by default, `remoteDesktop.followerSize`; `remoteDesktop.followerFps` frames per second, and a fraction of the driver's bandwidth, so a phone watching costs the driver little), and draws the driver's pointer where it is. A driver tab that reloads gets its seat back, unless someone took over meanwhile.

The desktop scale follows the driver's pixel ratio: on a managed display the host sets XFCE's window scaling to match, which GTK apps pick up at once.

## Native clients

The remote-pc viewer, `rpc-client` (from the same [releases](https://github.com/tuanpham-dev/remote-pc-releases/releases)), can join the desktop from another Linux machine: a native window with the lowest latency, files by drag and drop, and sound. While the desktop runs, the panel shows its network name (`<hostname> (Perch)`) and UDP port. **Pair a native client** shows a PIN for two minutes and the commands to type on the other machine:

```sh
rpc-client pair "tuan-server (Perch)" --pin 123456     # once; kept across Starts
rpc-client connect "tuan-server (Perch)"
```

It joins like a tab: the driver, or a follower with a **Take over** button in its toolbar. When the desktop is stopped, the client says the session ended (it doesn't keep retrying). If it can't reach the desktop, open the UDP port on this machine (`sudo ufw allow 48000/udp`). Set `remoteDesktop.udpPort` to 0 to keep the desktop to this machine's browser tabs.

## Managed and existing displays

- **Managed** (default): the host starts a headless sway on the GPU, a rootful Xwayland inside it with the keyboard layout applied, and the desktop command on that. The display resizes to the tab: drag the sidebar or resize the window and the desktop reflows a moment later. Everything the host started ends with it, so **Stop** leaves no sway, Xwayland or desktop behind.
- **Existing**: the host attaches to the desktop that already runs: an X display (captured through shared memory, input through XTEST), a wlroots compositor such as sway (captured through screencopy, input through its virtual keyboard and pointer, so no extra permissions are needed), GNOME (through Mutter's remote desktop interface, no prompt) or KDE Plasma (through its desktop portal, which asks its user once); GNOME's and KDE's screens arrive as GPU buffers, without a copy, when the GPU encodes. The size is never changed; a screen larger than the tab is scaled down to fit. Empty `remoteDesktop.display` finds the running desktop, skipping the host's own managed ones; set it to force one (`:0`, a socket such as `wayland-1`, `gnome` or `kde`). Its sound is your session's own (what its default output plays), and the clipboard is shared on all of them (on wlroots and KDE through wlr-data-control, on GNOME through Mutter). Launch is not offered.

## Settings

The gear in the Remote Desktop panel's header opens these in Settings.

| Setting | Default | Description |
|---|---|---|
| `remoteDesktop.mode` | `managed` | `managed` starts a virtual display and a desktop; `existing` attaches to the running one. |
| `remoteDesktop.display` | empty | Existing mode: the desktop to attach to (`:0`, `wayland-1`, `gnome`, `kde`); empty finds it. |
| `remoteDesktop.desktopCommand` | `xfce4-session` | Managed: the desktop session command. |
| `remoteDesktop.useGlobalConfig` | `false` | Managed: run the desktop with your own `~/.config` instead of a fresh config directory each Start. |
| `remoteDesktop.keyboardLayout` | `us` | XKB layout for the virtual display (and the keyboard added to an existing Wayland desktop). |
| `remoteDesktop.port` | `14600` | Preferred loopback port; the next free one is used if taken. |
| `remoteDesktop.bitrateKbps` | `40000` | Upper bitrate limit; the stream adapts below it, and the viewer's quality preset caps it further. |
| `remoteDesktop.codec` | `auto` | `auto` (H.264, which every browser decodes), `h264` or `h265`. All viewers share the codec. |
| `remoteDesktop.followerFps` | `15` | Frame rate of the followers' lighter stream (1–30). |
| `remoteDesktop.renderer` | `auto` | Managed: `gpu`, `software` (pixman, no GPU) or `auto` (the GPU when its render node opens). Without a GPU encoder rpc-host encodes on the CPU (OpenH264, H.264 up to 3840x2160 at 30 fps) either way. |
| `remoteDesktop.followerSize` | `1080p` | Size of the followers' stream: `720p`, `1080p`, `1440p` or `full` (the driver's resolution; the most encoding and bandwidth). |
| `remoteDesktop.udpPort` | `48000` | The UDP port native `rpc-client`s on other machines connect to (open it in the firewall); 0 keeps the desktop on this machine. |
| `remoteDesktop.portMapping` | `false` | Ask the router to forward that port (PCP, NAT-PMP or UPnP) so native clients outside this network connect directly, over IPv4 or IPv6; the panel's *Outside access* line shows whether it worked. Tabs don't need it. |
| `remoteDesktop.pixelRatio` | `auto` | Default remote pixels per CSS pixel for your devices: `auto` (each device's own ratio, capped at 2), `1`, `1.5` or `2`. Any browser can override it for itself in the view settings. |
| `remoteDesktop.serverPath` | empty | Path to your own `rpc-host`; empty means the downloaded one, then PATH, then `~/.cargo/bin`. |

Changes apply on the next Start.

## The viewer tab

- **Keyboard**: keys are forwarded by physical position, including modifiers, function keys and the numeric keypad. Keys held when the tab loses focus are released on the remote side.
- **Phone keyboard**: on a touch device the toolbar has a keyboard button; tap it to open the phone's keyboard. What you type is typed on the desktop as characters, so accents, emoji and other scripts arrive as written whatever the desktop's layout. A strip of extra keys comes with it: Esc, Tab, the arrows, Home, End, PgUp, PgDn, and sticky Ctrl, Alt and Super that apply to the next key; hold a modifier to lock it until you tap it again. View settings → Keys strip changes which keys it has. While the keyboard is up the picture fits above it and the desktop keeps its size.
- **Mouse and touch**: left, middle and right buttons, both wheel axes. On a touch screen: tap = click, long press or two-finger tap = right click, three-finger tap = middle click, one-finger drag = drag, two-finger drag = scroll (pan while zoomed in), pinch = zoom. **Trackpad** (view settings, Touch) makes one finger move the pointer like a trackpad instead. View settings → Gestures sets what each gesture does, and pointer speed and acceleration.
- **View settings** (toolbar, gear icon): the display **size** this tab asks for while it drives (follow the tab, or a fixed resolution), the **pixel ratio** this device uses, the **view** (Fit, Fill, or 100%), and the **quality** preset (High, Medium or Low caps the bitrate at 100%, 40% or 15%). Kept in this browser only.
- **Zoom**: Ctrl+wheel, a pinch, or the − and + buttons in the view settings, from 25% to 400%. **Lock zoom** makes a pinch or Ctrl+wheel change nothing.
- **Audio**: the speaker button plays the desktop's sound in the tab (Opus). It is off until clicked, and the choice is kept in this browser.
- **Clipboard**: paste in the tab (Ctrl+V) sends your clipboard, text or a PNG image, to the desktop. Text or an image copied inside the desktop is written to your clipboard when the tab has focus; if the browser refuses, the **copy remote clipboard** toolbar button copies it on click. Images up to 16 MB.
- **Files**: drop a file on the desktop (while you drive) to send it to the host's `~/Downloads/remote-pc`, checked by its SHA-256 (up to 2 GB). A file placed in the host's `~/remote-pc/Outbox` downloads in every open tab (up to 512 MB in a browser).
- **Cursor**: on X11 displays and the managed desktop the pointer shape comes from the desktop (I-beam, resize arrows, busy), drawn as the tab's own cursor, so there is exactly one pointer. On an existing Wayland desktop the pointer is part of the picture.
- **Stats** (toolbar): remote size, codec and encoder, fps, bitrate, round-trip time, decode time, dropped frames, viewer count.
- **Fullscreen** (toolbar): real browser fullscreen, and every key goes to the desktop; in Chromium-based browsers a keyboard lock hands over browser shortcuts like Ctrl+T too. Hold Escape to exit. Ctrl+W still closes the browser tab.
- **Decoding**: WebCodecs, with hardware acceleration where the browser has it. A browser without WebCodecs sees a banner and no stream.
- **Reconnect**: if the connection drops the tab keeps the last frame and reconnects; after a Stop and Start it picks up the new session by itself.

## Known limitations

- Keyboard forwarding by physical position assumes the desktop's layout matches your keyboard; set `remoteDesktop.keyboardLayout`.
- No microphone, gamepads or pen from the browser.
- Existing mode on KDE: its user approves sharing the first time (the approval is remembered).
- A browser keeps a downloaded file in memory until it is saved, so files from the host are limited to 512 MB there.

## When something is off

The host's log is in `~/.local/share/perch-remote-desktop/host.log`, truncated on each Start. It records the rate controller's decisions (why the bitrate changed), viewers joining and leaving, files and clipboard transfers, and the host's warnings. To report a problem, do it once and send the lines from that moment.
