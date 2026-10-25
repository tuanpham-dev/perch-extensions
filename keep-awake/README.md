# Keep Awake

Keeps the computer running Perch from going to sleep. Click the coffee cup in the status bar and pick:

- **On** - Keep this computer awake continuously
- **Agent** - Stay awake while an agent is working, and for 30 minutes after the last one finishes
- **Off** - Allow normal system sleep behavior

The cup is highlighted while the computer is being kept awake, and the popover says so too.

**Which computer:** the one the Perch server runs on, since that's where your agents run. With the desktop app's Local server it's the computer in front of you; with a remote server it's that machine. The choice is one setting per server, kept across restarts.

**Only sleep, not the screen:** the computer stays up but its screen can still turn off. To keep the screen of the device you're looking from on as well, tick **Keep this screen on too** in the popover. That's per device, and only works while Perch is the tab or window in front, since that's all a browser or installed app (PWA) is allowed to do. Browsers only allow it on secure pages: `https://` or `localhost`.

**How agents are followed:** through the agent hooks Perch installs (Settings → AI Providers). A turn starts when you send a prompt and ends when the agent stops or asks for permission (whoever answers it is at the keyboard anyway). A turn whose terminal closes, or that sees no stop for 6 hours, counts as over.

**How it keeps the computer awake:**

- **Linux:** `systemd-inhibit`, blocking sleep and idle. Blocking sleep needs a desktop session; for a server started outside one (a systemd user service, ssh) it blocks idle only, and the popover says so.
- **macOS:** `caffeinate -i`.
- **Windows:** `SetThreadExecutionState`, through PowerShell.

Each helper process ends with the Perch server, so a crash can't leave the computer unable to sleep.
