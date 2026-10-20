import { useEffect, useMemo, useState } from "react";
import { JsonTree } from "./JsonTree";
import type { HttpResponse } from "./host";

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function statusClass(status: number): string {
  if (status >= 500) return "bad";
  if (status >= 400) return "warn";
  return "ok";
}

export function ResponseView({ response }: { response: HttpResponse }) {
  const [tab, setTab] = useState<"body" | "headers">("body");
  const [raw, setRaw] = useState(false);
  const bytes = useMemo(() => bytesOf(response.bodyBase64), [response.bodyBase64]);
  const type = response.contentType.toLowerCase();
  const text = useMemo(() => (type.startsWith("image/") ? "" : new TextDecoder().decode(bytes)), [bytes, type]);
  const json = useMemo(() => {
    if (!/json/.test(type) && !/^\s*[[{]/.test(text)) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }, [text, type]);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!type.startsWith("image/") || response.truncated) return;
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [bytes, type, response.truncated]);

  return (
    <div className="hc-response">
      <div className="hc-status-line">
        <span className={`hc-status ${statusClass(response.status)}`}>
          {response.status} {response.statusText}
        </span>
        <span className="hc-meta">{response.timeMs} ms</span>
        <span className="hc-meta">{formatSize(response.sizeBytes)}</span>
      </div>
      <div className="hc-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "body"} className={tab === "body" ? "active" : ""} onClick={() => setTab("body")}>
          Body
        </button>
        <button role="tab" aria-selected={tab === "headers"} className={tab === "headers" ? "active" : ""} onClick={() => setTab("headers")}>
          Headers ({response.headers.length})
        </button>
        {tab === "body" && json !== undefined && (
          <button className="hc-raw-toggle" onClick={() => setRaw((v) => !v)}>
            {raw ? "Tree" : "Raw"}
          </button>
        )}
      </div>
      {response.truncated && (
        <div className="hc-notice">The body is {formatSize(response.sizeBytes)}; the first 10 MB is shown. Save Response… writes all of it.</div>
      )}
      <div className="hc-response-body">
        {tab === "headers" ? (
          <table className="hc-headers">
            <tbody>
              {response.headers.map(([k, v], i) => (
                <tr key={i}>
                  <th>{k}</th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : imageUrl ? (
          <img className="hc-image" src={imageUrl} alt="Response image" />
        ) : json !== undefined && !raw ? (
          <JsonTree value={json} />
        ) : text ? (
          <pre className="hc-text">{json !== undefined ? JSON.stringify(json, null, 2) : text}</pre>
        ) : (
          <div className="hc-muted">No body.</div>
        )}
      </div>
    </div>
  );
}
