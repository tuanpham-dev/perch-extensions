// Codex's own numbers, asked of Codex.
//
// Codex stopped recording usage in its rollout files (every token_count line
// since 2026-09-11 here carries info: null and an empty rate_limits block),
// so the files alone can say nothing about how close an account is to its
// limit. The CLI knows: `codex app-server` speaks JSON-RPC over stdio and
// answers account/rateLimits/read and account/usage/read, which is the same
// data its own UI shows. Asking it keeps the account token inside Codex's
// process — nothing here reads a credential or talks to a network service.
//
// Verified against codex-cli 0.154.0 on 2026-09-15.
import { spawn } from "node:child_process";

const INIT_TIMEOUT_MS = 8_000;
const CALL_TIMEOUT_MS = 8_000;
// Spawning a CLI is far heavier than reading a file, and these numbers move
// on the order of minutes, so one answer serves a minute of polling.
const CACHE_TTL_MS = 60_000;

let cache = null; // { at, value }
let inFlight = null;

// One short-lived app-server process: initialize, ask, done. Kept as a
// request/response session rather than a long-running child so a crashed or
// hung CLI can never leave a process behind.
async function ask(methods) {
  const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let nextId = 1;
  let buf = "";

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // notifications and logs this doesn't speak
      }
      const resolve = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  const call = (method, params, timeoutMs) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`codex app-server timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message ?? `codex app-server error: ${method}`));
        else resolve(msg.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    await call("initialize", { clientInfo: { name: "agent-usage-monitor", version: "1.0.0" } }, INIT_TIMEOUT_MS);
    const out = {};
    for (const [key, method, params] of methods) {
      out[key] = await call(method, params, CALL_TIMEOUT_MS);
    }
    return out;
  } finally {
    child.kill();
  }
}

// Is the CLI there at all? A machine without codex must not pay for a failed
// spawn on every poll, so a refusal is cached like an answer.
export function isAvailable(result) {
  return result !== null && result.error !== "unavailable";
}

// { limits, dailyTokens, planType } from the CLI, or null when it can't be
// reached. Never throws: every caller treats this as a best-effort extra on
// top of what the files say.
export async function readAccount() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  if (inFlight) return inFlight;
  inFlight = ask([
    ["rateLimits", "account/rateLimits/read", null],
    ["usage", "account/usage/read", {}],
  ])
    .then((raw) => ({ limits: raw.rateLimits ?? null, usage: raw.usage ?? null }))
    .catch(() => null)
    .then((value) => {
      cache = { at: Date.now(), value };
      inFlight = null;
      return value;
    });
  return inFlight;
}

// Exported for the tests: the response shapes turned into what the UI draws.
// Codex reports window length in minutes and reset times in epoch seconds.
export function limitsFromAccount(account, now) {
  const snapshot = account?.limits?.rateLimits;
  if (!snapshot) return [];
  const out = [];
  for (const key of ["primary", "secondary"]) {
    const window = snapshot[key];
    if (!window || typeof window.usedPercent !== "number") continue;
    const resetsAt = typeof window.resetsAt === "number" ? window.resetsAt * 1000 : null;
    if (resetsAt !== null && resetsAt <= now) continue;
    out.push({ label: windowLabel(window.windowDurationMins), usedPercent: window.usedPercent, resetsAt });
  }
  return out;
}

// Tokens Codex itself attributes to today, from its daily buckets — the
// blocks below are built from rollout files, which record nothing while an
// account is out of quota, so this is often the only token figure there is.
export function todayTokensFromAccount(account, now) {
  const buckets = account?.usage?.dailyUsageBuckets;
  if (!Array.isArray(buckets) || buckets.length === 0) return null;
  const today = new Date(now);
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const bucket = buckets.find((b) => b?.startDate === key);
  return typeof bucket?.tokens === "number" ? bucket.tokens : null;
}

export function planType(account) {
  const plan = account?.limits?.rateLimits?.planType;
  return typeof plan === "string" && plan ? plan : null;
}

// Codex names its windows only by length in minutes.
export function windowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "limit";
  if (minutes < 60 * 24) return `${Math.max(1, Math.round(minutes / 60))}-hour`;
  const days = Math.round(minutes / (60 * 24));
  if (days === 1) return "daily";
  if (days === 7) return "weekly";
  return `${days}-day`;
}
