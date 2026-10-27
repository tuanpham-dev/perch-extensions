# Keep Awake

Keeps the computer you're using Perch on from going to sleep, in Perch's desktop app, a browser or the installed app (PWA). Click the coffee cup in the status bar and pick:

- **On** - Keep this computer awake continuously
- **Agent** - Stay awake while an agent is working, and for 30 minutes after the last one finishes
- **Off** - Allow normal system sleep behavior

The cup is highlighted while the computer is being kept awake, and the popover says so too.

**Which computer:** the device you're looking from. The machine running the Perch server is always on anyway; it's your laptop that would doze off while an agent works. The choice is per device, so a phone and a laptop can each have their own.

**How, in Perch's desktop app:** the app holds the OS's own lock: `caffeinate -d -i` on macOS, `systemd-inhibit` on Linux, `SetThreadExecutionState` on Windows. It holds whether the Perch window is in front or not, until you turn it off or close the window. On macOS and Windows the screen stays on too, so the session doesn't lock (desktop app 0.10.5 or later; older ones keep only the computer up). This needs the desktop app 0.10.3 or later; older ones use the browser's way below.

**How, in a browser or installed app (PWA):** a screen wake lock. A web page can't stop its computer from sleeping outright, but it can keep the screen on, and a computer whose screen is kept on doesn't idle into sleep. Browsers set two limits on it:

- Only while Perch is the tab or window in front. Switch to another tab or minimize the window and the lock goes; it's taken again as soon as Perch is back in front.
- Only on secure pages: `https://` or `localhost`. Over plain `http://` from another machine the popover says it can't.

Either way, closing the lid still sleeps the computer, as usual.

**How agents are followed:** through the agent hooks Perch installs (Settings → AI Providers). A turn starts when you send a prompt and ends when the agent stops or asks for permission (whoever answers it is at the keyboard anyway). A turn whose terminal closes, or that sees no stop for 6 hours, counts as over.
