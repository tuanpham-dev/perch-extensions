// Packs each top-level extension folder into a .perch — a zip whose contents
// sit under a top-level extension/ folder, matching what Perch's
// installFromPackageFile (server/src/extensions.ts) expects to unzip.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(repoRoot, "dist");

// Discovered rather than hardcoded — any top-level folder with a
// package.json is an extension, so adding one under the repo root is picked
// up automatically (mirrors Perch's own listFoldersIn/discoverExtensions
// pattern in server/src/extensions.ts).
const EXTENSIONS = readdirSync(repoRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(path.join(repoRoot, e.name, "package.json")))
  .map((e) => e.name);

mkdirSync(distDir, { recursive: true });

// Entries for dist/index.json — the registry catalog Perch's server/src/registry.ts
// reads for this repo's dist/ (or a hosted copy of it) as a registry source.
const indexEntries = [];

for (const name of EXTENSIONS) {
  const srcDir = path.join(repoRoot, name);
  const manifest = JSON.parse(readFileSync(path.join(srcDir, "package.json"), "utf8"));
  const version = manifest.version || "0.0.0";

  const workDir = mkdtempSync(path.join(tmpdir(), "perch-ext-pack-"));
  try {
    const stagedRoot = path.join(workDir, "extension");
    mkdirSync(stagedRoot, { recursive: true });
    cpSync(srcDir, stagedRoot, { recursive: true });

    // Zipped to a uniquely-named path inside dist/ itself (not workDir, whose
    // filesystem may differ from dist/'s and make the rename below fail with
    // EXDEV — see installFromPackageFile's own cp-not-rename comment for the
    // same tradeoff), then moved into place with a same-directory atomic
    // rename — two concurrent `npm run pack` runs would otherwise both write
    // the same dist/<name>.perch path and could interleave/corrupt output.
    const packageName = `${name}-${version}.perch`;
    const stagedPackagePath = path.join(distDir, `.tmp-${randomUUID()}-${packageName}`);
    try {
      execFileSync("zip", ["-q", "-r", stagedPackagePath, "extension"], { cwd: workDir });
      renameSync(stagedPackagePath, path.join(distDir, packageName));
    } catch (err) {
      rmSync(stagedPackagePath, { force: true });
      if (err.code === "ENOENT") {
        throw new Error('packing extensions requires the "zip" command, which was not found on PATH');
      }
      throw err;
    }
    console.log(`packed ${packageName}`);

    // README/icon are copied out of the source folder (not the staged
    // extension/ dir the .perch was built from) — same files, but this way a
    // future non-flat srcDir layout can't accidentally change these paths.
    const entry = {
      name: manifest.name,
      publisher: manifest.publisher,
      displayName: manifest.displayName || manifest.name,
      description: manifest.description || "",
      version,
      file: packageName,
    };
    const readmePath = path.join(srcDir, "README.md");
    if (existsSync(readmePath)) {
      const readmeName = `${name}-README.md`;
      copyFileSync(readmePath, path.join(distDir, readmeName));
      entry.readme = readmeName;
    }
    if (typeof manifest.icon === "string") {
      const iconSrcPath = path.join(srcDir, manifest.icon);
      if (existsSync(iconSrcPath)) {
        const iconName = `${name}-icon${path.extname(manifest.icon)}`;
        copyFileSync(iconSrcPath, path.join(distDir, iconName));
        entry.icon = iconName;
      } else {
        console.warn(`${name}: manifest declares icon "${manifest.icon}" but the file is missing — skipping`);
      }
    }
    indexEntries.push(entry);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// Atomic write, staged inside dist/ itself — same rationale as the .perch
// staging above (cross-filesystem rename safety + no interleaved writes from
// concurrent pack runs).
const indexJson = JSON.stringify({ extensions: indexEntries }, null, 2);
const stagedIndexPath = path.join(distDir, `.tmp-${randomUUID()}-index.json`);
writeFileSync(stagedIndexPath, indexJson);
renameSync(stagedIndexPath, path.join(distDir, "index.json"));
console.log(`wrote index.json (${indexEntries.length} extensions)`);
