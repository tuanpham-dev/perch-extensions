// What every engine adapter shares: the errors it raises, how values are made
// safe for JSON, and running a query against a deadline.

export const READ_ONLY_MESSAGE = "This connection is read-only. Make it writable in its settings to run this.";

export class QueryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export class ReadOnlyError extends QueryError {
  // `reason`: what in the query was refused, shown after the usual message.
  constructor(reason) {
    super(reason ? `${READ_ONLY_MESSAGE} (${reason})` : READ_ONLY_MESSAGE, 403);
  }
}

// A value as the results grid shows it: JSON-safe, with binary as hex and
// big integers as strings. null stays null, so NULL can be told from "null".
export function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v);
    return `\\x${b.subarray(0, 256).toString("hex")}${b.length > 256 ? "…" : ""}`;
  }
  if (typeof v === "object") {
    try {
      return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
    } catch {
      return String(v);
    }
  }
  return v;
}

// How a connection failure reads, naming where it tried.
export function connectionMessage(err, where) {
  const code = err?.code ?? err?.cause?.code;
  if (code === "ECONNREFUSED") return `Connection refused at ${where}`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `No such host: ${where.split(":")[0]}`;
  if (code === "ETIMEDOUT" || /timed? ?out/i.test(err?.message ?? "")) return `No answer from ${where}`;
  return err?.message ? `${err.message} (${where})` : `Couldn't connect to ${where}`;
}

// Runs `work` with a deadline; on expiry `onTimeout` (which cancels the query
// on the server) runs and the call rejects with a timeout message.
export async function withDeadline(work, timeoutMs, onTimeout) {
  let timer;
  let timedOut = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      Promise.resolve(onTimeout?.()).catch(() => {});
      reject(new QueryError(`Timed out after ${Math.round(timeoutMs / 1000)} s`, 408));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } catch (err) {
    if (timedOut) throw new QueryError(`Timed out after ${Math.round(timeoutMs / 1000)} s`, 408);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// A rows result, capped at `limit`.
export function rowsResult(columns, rows, limit, notes = []) {
  const truncated = rows.length > limit;
  return { kind: "rows", columns, rows: rows.slice(0, limit).map((r) => r.map(cellValue)), truncated, rowCount: rows.length, notes };
}
