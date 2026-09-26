// Screenshots an agent hands over, checked and copied into the extension's own
// store. Shared by the batch runner and the review runner so an image is held
// to the same rules whichever flow reported it.
//
// Images are COPIED rather than referenced where the agent left them: a
// worktree removed after review must not empty the panel.
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// By content, not by extension: a file named .png that is not one would reach
// an <img> and render as nothing, which reads as a broken feature rather than
// a rejected file.
export const IMAGE_KINDS = [
  { ext: "png", test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "jpg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: "webp",
    test: (b) => b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  },
];

export class ImageError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// `flag` is how the agent named it on the command line, so a refusal points
// at the argument to fix.
export async function readImage(flag, file) {
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new ImageError(`--${flag}: there is no file at ${file}`);
  }
  if (!info.isFile()) throw new ImageError(`--${flag}: ${file} is not a file`);
  if (info.size > MAX_IMAGE_BYTES) {
    throw new ImageError(`--${flag}: ${file} is ${Math.round(info.size / 1024 / 1024)}MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`);
  }
  const bytes = await readFile(file);
  const kind = IMAGE_KINDS.find((entry) => entry.test(bytes));
  if (!kind) throw new ImageError(`--${flag}: ${file} is not a PNG, JPEG or WebP`);
  return { bytes, ext: kind.ext };
}

// Writes `<dir>/<name>.<ext>` owner-only and removes the same name in the
// other formats, so a re-report that switched format leaves no stale twin.
export async function writeImage(dir, name, { bytes, ext }) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${name}.${ext}`);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, bytes, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
  for (const other of IMAGE_KINDS) {
    if (other.ext !== ext) await rm(path.join(dir, `${name}.${other.ext}`), { force: true });
  }
  return { ext };
}

export function contentTypeOf(ext) {
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
}
