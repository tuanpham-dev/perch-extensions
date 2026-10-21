// Memory on macOS, which has no /proc/meminfo. Node's os.freemem() there is
// only the "Pages free" count, which on a Mac that has been up for an hour is
// a sliver of RAM - the kernel keeps everything else busy as file cache - so
// total - freemem() reads as nearly full on a healthy machine. `vm_stat` has
// the counts to do it properly:
//
//   available = free + inactive + speculative pages
//
// the pages the kernel can hand to a new workload without paging anything
// out, the same idea as Linux's MemAvailable. The page size is read from
// vm_stat's own header ("page size of 16384 bytes" on Apple silicon, 4096 on
// Intel) rather than assumed. Swap comes from `sysctl vm.swapusage`.
import { execFile } from "node:child_process";

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}

// vm_stat's output: { pageSize, pages: { "free": n, "active": n, ... } }, keyed
// by the label with "Pages " dropped and lowercased. Null when the header with
// the page size is missing, since no count means anything without it.
export function parseVmStat(text) {
  if (typeof text !== "string") return null;
  const header = /page size of (\d+) bytes/.exec(text);
  if (!header) return null;
  const pageSize = Number(header[1]);
  const pages = {};
  for (const line of text.split("\n")) {
    // `Pages free:      13171.` - the label may be quoted ("Translation
    // faults") and the count ends in a period.
    const m = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/.exec(line.trim());
    if (!m) continue;
    pages[m[1].replace(/^Pages\s+/i, "").trim().toLowerCase()] = Number(m[2]);
  }
  return { pageSize, pages };
}

// Bytes available and in use, out of `totalBytes` (hw.memsize, which
// os.totalmem() reports). Null when vm_stat lacks the counts this needs.
export function memoryFromVmStat(parsed, totalBytes) {
  if (!parsed) return null;
  const { pageSize, pages } = parsed;
  if (![pages.free, pages.inactive].every(Number.isFinite)) return null;
  const available = Math.min(totalBytes, (pages.free + pages.inactive + (pages.speculative ?? 0)) * pageSize);
  return { availableBytes: available, usedBytes: Math.max(0, totalBytes - available) };
}

// `sysctl vm.swapusage`: "vm.swapusage: total = 2048.00M  used = 1080.25M
// free = 967.75M  (encrypted)". Units are K, M or G. Null when unreadable.
export function parseSwapUsage(text) {
  if (typeof text !== "string") return null;
  const units = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  const field = (name) => {
    const m = new RegExp(`${name}\\s*=\\s*([\\d.]+)([BKMGT])`).exec(text);
    return m ? Math.round(Number(m[1]) * units[m[2]]) : null;
  };
  const total = field("total");
  const used = field("used");
  if (total === null || used === null) return null;
  return { swapTotalBytes: total, swapUsedBytes: used };
}

// The macOS reading, in readMemory's shape. Null when vm_stat can't be run or
// read, so the caller falls back to os.freemem().
export async function readDarwinMemory(totalBytes) {
  const [vm, swap] = await Promise.all([run("vm_stat", []), run("sysctl", ["vm.swapusage"])]);
  const memory = memoryFromVmStat(parseVmStat(vm), totalBytes);
  if (!memory) return null;
  const swapUsage = parseSwapUsage(swap) ?? { swapTotalBytes: 0, swapUsedBytes: 0 };
  return { memTotalBytes: totalBytes, memUsedBytes: memory.usedBytes, ...swapUsage };
}
