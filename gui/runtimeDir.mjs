// Where xpra keeps its control sockets: private to this user, so no one else
// on the host can reach the display through them.
//
// $XDG_RUNTIME_DIR/perch-gui when the login session has a runtime dir (it is
// already 0700 and owned by the user). Otherwise a fixed folder in /tmp,
// created 0700; one that is already there is used only when it is a real
// directory (not a link) owned by this user with nothing looser than 0700 -
// anything else could be someone else's trap, and is refused.
//
// xpra's socket path lives under this folder, and AF_UNIX paths stop at about
// 108 characters, so an unusually long $XDG_RUNTIME_DIR (some tools point it
// deep into a project) falls back to /tmp rather than failing to bind.
import { lstat, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const MAX_BASE_LENGTH = 64;

export async function pickRuntimeDir(env = process.env, uid = process.getuid()) {
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg && path.isAbsolute(xdg) && xdg.length <= MAX_BASE_LENGTH) {
    const ok = await stat(xdg).then((s) => s.isDirectory(), () => false);
    if (ok) return path.join(xdg, "perch-gui");
  }
  return `/tmp/perch-gui-${uid}`;
}

// Creates the folder if it's missing, then checks it. Throws, with a message
// for the user, when it can't be trusted.
export async function ensurePrivateDir(dir, uid = process.getuid()) {
  // Never recursive: a missing parent is an error, not something to make.
  await mkdir(dir, { mode: 0o700 }).catch((err) => {
    if (err.code !== "EEXIST") throw err;
  });
  const info = await lstat(dir);
  if (!info.isDirectory()) {
    throw new Error(`${dir} is not a plain folder (a link or a file?) - remove it and start again.`);
  }
  if (info.uid !== uid) {
    throw new Error(`${dir} belongs to another user, so it isn't safe for the display's sockets - remove it and start again.`);
  }
  if ((info.mode & 0o077) !== 0) {
    const mode = (info.mode & 0o777).toString(8);
    throw new Error(`${dir} can be opened by other users (mode ${mode}) - run chmod 700 on it, or remove it, and start again.`);
  }
  return dir;
}
