// HTTP Client server hook. Requests are made from here, the Perch server, on
// purpose: "localhost" then means the machine your dev servers run on, from
// a phone as much as from the laptop. There is no host allowlist - whoever
// can use this already has a shell on this machine.
//
//   POST /send           { id, method, url, headers: [[k, v]], body, timeoutSeconds }
//   POST /cancel         { id }
//   POST /save-response  { id, path, overwrite? }  the full body of response `id`
//   GET  /env?dir=&root= environments from http-client(.private).env.json
//   GET  /history?key=   POST /history { key, entry }
//   POST /append         { path, text }  a request appended to a .http file
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// History lives in the host's extension storage (Perch 0.9+), collection
// "history": one record per sent request, keyed "<hash of the history
// key>/<zero-padded ms>", so saving one entry writes that entry alone however
// big the rest of the history is. Responses too big to send inline are
// spooled to files in the extension's private files folder. Set by activate().
let spoolDir = "";

// What the browser gets inline; the rest stays in a spool file for Save
// Response…. Past SPOOL_LIMIT the download is stopped.
const INLINE_LIMIT = 10 * 1024 * 1024;
const SPOOL_LIMIT = 500 * 1024 * 1024;
const HISTORY_PER_KEY = 50;
const HISTORY_BODY_LIMIT = 1024 * 1024;
const KEPT_RESPONSES = 20;

const inFlight = new Map(); // id -> AbortController
const responses = new Map(); // id -> { buffer } | { file }

function expandHome(p) {
  if (typeof p !== "string") return "";
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function forget(id) {
  const kept = responses.get(id);
  responses.delete(id);
  if (kept?.file) await unlink(kept.file).catch(() => {});
}

async function keep(id, entry) {
  await forget(id);
  responses.set(id, entry);
  while (responses.size > KEPT_RESPONSES) await forget(responses.keys().next().value);
}

// A history key (a request's file and name) as a fixed-length record prefix.
export const historyPrefix = (key) => `${createHash("sha256").update(key).digest("hex").slice(0, 24)}/`;

// Saves one history entry in `history` (a storage collection inside a
// transaction) and keeps only the newest `limit` for its key.
export function addHistoryEntry(history, key, entry, at, limit = HISTORY_PER_KEY) {
  const prefix = historyPrefix(key);
  history.put(`${prefix}${String(at).padStart(15, "0")}`, entry);
  // Keys only: the values can be a megabyte each.
  const all = history.list({ prefix, keysOnly: true });
  for (const r of all.slice(0, Math.max(0, all.length - limit))) history.delete(r.key);
}

const safeId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);

export function activate({ router, getSettings, log, storage }) {
  // A Perch older than 0.9 has no extension storage to keep history in.
  if (!storage) {
    log?.("HTTP Client needs Perch 0.9 or newer (no extension storage)");
    return;
  }
  spoolDir = path.join(storage.filesDir(), "spool");
  router.post("/send", async (req, res) => {
    const { id, method, url, headers, body } = req.body ?? {};
    if (!safeId(id) || typeof method !== "string" || typeof url !== "string") {
      res.status(400).json({ error: "id, method and url are required" });
      return;
    }
    let target;
    try {
      target = new URL(url);
      if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("only http and https");
    } catch {
      res.status(400).json({ error: `Not a usable URL: ${url}` });
      return;
    }
    // getSettings() resolves to this extension's settings, defaults included.
    const configured = Number((await getSettings?.())?.["httpClient.timeoutSeconds"]);
    const requested = Number(req.body?.timeoutSeconds);
    const timeoutSeconds = Number.isFinite(requested) && requested > 0 ? requested : Number.isFinite(configured) && configured > 0 ? configured : 30;
    const controller = new AbortController();
    inFlight.get(id)?.abort();
    inFlight.set(id, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutSeconds * 1000);
    const started = performance.now();
    try {
      const upper = method.toUpperCase();
      const response = await fetch(target, {
        method: upper,
        headers: Array.isArray(headers) ? headers.filter((h) => Array.isArray(h) && h.length === 2).map(([k, v]) => [String(k), String(v)]) : [],
        body: upper === "GET" || upper === "HEAD" || !body ? undefined : String(body),
        redirect: "follow",
        signal: controller.signal,
      });
      const chunks = [];
      let size = 0;
      let spool = null; // { file, stream }
      const reader = response.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (!spool && size > INLINE_LIMIT) {
          await mkdir(spoolDir, { recursive: true, mode: 0o700 });
          const file = path.join(spoolDir, `${id}-${randomBytes(4).toString("hex")}`);
          const stream = createWriteStream(file, { mode: 0o600 });
          for (const c of chunks) stream.write(c);
          spool = { file, stream };
        }
        if (spool) spool.stream.write(value);
        else chunks.push(value);
        if (size > SPOOL_LIMIT) {
          controller.abort();
          break;
        }
      }
      const timeMs = Math.round(performance.now() - started);
      let inline = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      if (spool) {
        await new Promise((resolve) => spool.stream.end(resolve));
        inline = inline.subarray(0, INLINE_LIMIT);
        await keep(id, { file: spool.file });
      } else {
        await keep(id, { buffer: inline });
      }
      res.json({
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        contentType: response.headers.get("content-type") ?? "",
        timeMs,
        sizeBytes: size,
        truncated: Boolean(spool),
        bodyBase64: inline.toString("base64"),
        url: response.url,
      });
    } catch (err) {
      const where = `${target.hostname}:${target.port || (target.protocol === "https:" ? 443 : 80)}`;
      const cause = err?.cause?.code ?? err?.code;
      const message = timedOut
        ? `Timed out after ${timeoutSeconds} s`
        : controller.signal.aborted
          ? "Cancelled"
          : cause === "ECONNREFUSED"
            ? `Connection refused at ${where}`
            : cause === "ENOTFOUND"
              ? `No such host: ${target.hostname}`
              : `${err?.cause?.message ?? err.message}`;
      res.status(502).json({ error: message });
    } finally {
      clearTimeout(timer);
      if (inFlight.get(id) === controller) inFlight.delete(id);
    }
  });

  router.post("/cancel", (req, res) => {
    const id = req.body?.id;
    inFlight.get(id)?.abort();
    res.status(204).end();
  });

  router.post("/save-response", async (req, res) => {
    const { id, overwrite } = req.body ?? {};
    const dest = path.resolve(expandHome(String(req.body?.path ?? "")));
    const kept = responses.get(id);
    if (!kept) {
      res.status(404).json({ error: "That response is no longer kept. Send the request again." });
      return;
    }
    try {
      if (!overwrite && (await stat(dest).then(() => true, () => false))) {
        res.status(409).json({ error: `${dest} already exists` });
        return;
      }
      await mkdir(path.dirname(dest), { recursive: true });
      if (kept.file) await copyFile(kept.file, dest);
      else await writeFile(dest, kept.buffer);
      res.json({ path: dest });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Environment files beside the request file or in a folder above it, up
  // to `root` (the project); the nearest of each wins.
  router.get("/env", async (req, res) => {
    let dir = path.resolve(expandHome(String(req.query.dir ?? "")));
    const root = req.query.root ? path.resolve(expandHome(String(req.query.root))) : null;
    const read = async (name) => {
      try {
        return JSON.parse(await readFile(path.join(dir, name), "utf8"));
      } catch {
        return null;
      }
    };
    let shared = null;
    let priv = null;
    for (let i = 0; i < 12; i++) {
      shared ??= await read("http-client.env.json");
      priv ??= await read("http-client.private.env.json");
      if ((shared && priv) || (root && dir === root)) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    res.json({ shared: shared ?? {}, private: priv ?? {} });
  });

  router.get("/history", async (req, res) => {
    const key = String(req.query.key ?? "");
    const rows = await storage.collection("history").list({ prefix: historyPrefix(key) });
    // Newest first, as before.
    res.json({ entries: rows.reverse().map((r) => r.value) });
  });

  router.post("/history", (req, res) => {
    const { key, entry } = req.body ?? {};
    if (typeof key !== "string" || !key || !entry || typeof entry !== "object") {
      res.status(400).json({ error: "key and entry are required" });
      return;
    }
    if (typeof entry.bodyBase64 === "string" && entry.bodyBase64.length > (HISTORY_BODY_LIMIT * 4) / 3) delete entry.bodyBase64;
    storage
      .transaction((tx) => addHistoryEntry(tx.collection("history"), key, entry, Date.now()))
      .then(
        () => res.status(204).end(),
        (err) => {
          log?.("history write failed:", err.message);
          res.status(500).json({ error: err.message });
        },
      );
  });

  router.post("/append", async (req, res) => {
    const file = path.resolve(expandHome(String(req.body?.path ?? "")));
    const text = req.body?.text;
    if (!/\.(http|rest)$/i.test(file) || typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "path must be a .http or .rest file, and text a request" });
      return;
    }
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const existing = await readFile(file, "utf8").catch(() => "");
      const sep = existing.trim() ? `${existing.endsWith("\n") ? "" : "\n"}\n###\n` : "";
      await appendFile(file, `${sep}${text.replace(/\s+$/, "")}\n`);
      res.json({ path: file });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
