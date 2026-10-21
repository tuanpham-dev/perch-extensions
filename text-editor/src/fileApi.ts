// Minimal copies of the host's own file-content helpers (client/src/api.ts
// and the bundled extensions' _shared/fileApi.ts) — this editor reads and
// writes through the host's existing routes rather than adding file routes
// to a server hook, exactly like the bundled csv/json viewers do. Content
// moves as bytes, decoded and encoded here (textCodec.ts), so a file keeps its
// encoding and byte-order mark through a save.
import { decodeBytes, encodeText, UTF8, type FileEncoding } from "./textCodec";

export function downloadUrl(targetPath: string): string {
  return `/api/download?path=${encodeURIComponent(targetPath)}`;
}

export interface FileText {
  text: string;
  encoding: FileEncoding;
}

export async function fetchFileText(targetPath: string): Promise<FileText> {
  const res = await fetch(downloadUrl(targetPath));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return decodeBytes(new Uint8Array(await res.arrayBuffer()));
}

async function errorMessage(res: Response): Promise<string> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: string } | null;
    if (body?.error) message = body.error;
  } catch {
    // non-JSON error body; keep the status message
  }
  return message;
}

// Writes content back to targetPath via the host's upload route in overwrite
// mode — same mechanism CsvView's Save uses — in the encoding it was read in.
export async function saveFileText(targetPath: string, content: string, encoding: FileEncoding = UTF8): Promise<void> {
  // Encoded first: text the file's encoding can't hold fails before anything
  // is sent.
  const bytes = encodeText(content, encoding);
  const slash = targetPath.lastIndexOf("/");
  const dir = targetPath.slice(0, slash);
  const name = targetPath.slice(slash + 1);
  const url = `/api/upload?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(name)}&conflict=overwrite`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (!res.ok) throw new Error(await errorMessage(res));
}
