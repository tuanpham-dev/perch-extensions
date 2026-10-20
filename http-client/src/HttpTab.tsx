import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fromCurl, toCurl } from "./curl";
import { call, host, HttpError, pendingScratch, type HistoryEntry, type HttpResponse } from "./host";
import {
  environmentNames,
  formatRequest,
  mergeEnvironments,
  parseHttpFile,
  resolveRequest,
  type Environments,
  type HttpFile,
  type HttpRequest,
} from "./httpFile";
import { ResponseView, formatSize } from "./ResponseView";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
export const SCRATCH_PREFIX = "http-client://new/";
// 1 MB of body, as base64.
const HISTORY_BODY_BASE64 = Math.ceil((1024 * 1024 * 4) / 3);

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 12);
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// {{var}} spans in a request's text, marked missing when the selected
// environment can't fill them.
function Highlighted({ text, missing }: { text: string; missing: Set<string> }) {
  const parts = text.split(/(\{\{[^{}]+\}\})/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(part);
        if (!m) return <span key={i}>{part}</span>;
        return (
          <span key={i} className={`hc-var${missing.has(m[1]) ? " missing" : ""}`} title={missing.has(m[1]) ? `${m[1]} has no value` : undefined}>
            {part}
          </span>
        );
      })}
    </>
  );
}

interface Scratch {
  method: string;
  url: string;
  headers: string;
  body: string;
}

function scratchToRequest(s: Scratch): HttpRequest {
  const headers: [string, string][] = s.headers
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const c = l.indexOf(":");
      return (c > 0 ? [l.slice(0, c).trim(), l.slice(c + 1).trim()] : [l, ""]) as [string, string];
    });
  return { method: s.method, url: s.url.trim(), headers, body: s.body, startLine: 0 };
}

export function HttpTab({ filePath, active, toolbarTarget, reloadKey }: { filePath: string; active: boolean; toolbarTarget?: HTMLDivElement | null; reloadKey?: number }) {
  const scratch = filePath.startsWith(SCRATCH_PREFIX);
  const [source, setSource] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [envs, setEnvs] = useState<Environments>({});
  const [env, setEnv] = useState<string | null>(null);
  const [draft, setDraft] = useState<Scratch>(() => ({ method: "GET", url: pendingScratch.get(filePath) ?? "", headers: "", body: "" }));
  const [selected, setSelected] = useState(0);
  const [response, setResponse] = useState<HttpResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const historyKey = scratch ? "scratch" : filePath;
  const baseDir = scratch ? (host.app?.getActiveContext().cwd ?? "") : dirOf(filePath);
  const cancelRef = useRef<string | null>(null);

  const loadFile = useCallback(() => {
    if (scratch) return;
    fetch(`/api/download?path=${encodeURIComponent(filePath)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((text) => {
        setSource(text);
        setLoadError(null);
      })
      .catch((err: Error) => setLoadError(err.message));
  }, [filePath, scratch]);

  useEffect(() => loadFile(), [loadFile, reloadKey]);
  useEffect(() => {
    if (active) loadFile();
  }, [active, loadFile]);

  useEffect(() => {
    if (!baseDir) return;
    call<{ shared: Environments; private: Environments }>(`/env?dir=${encodeURIComponent(baseDir)}`)
      .then((d) => {
        const merged = mergeEnvironments(d.shared, d.private);
        setEnvs(merged);
        const names = environmentNames(merged);
        setEnv((current) => (current && names.includes(current) ? current : (names[0] ?? null)));
      })
      .catch(() => {});
  }, [baseDir, source]);

  const loadHistory = useCallback(() => {
    call<{ entries: HistoryEntry[] }>(`/history?key=${encodeURIComponent(historyKey)}`)
      .then((d) => setHistory(d.entries))
      .catch(() => {});
  }, [historyKey]);
  useEffect(() => loadHistory(), [loadHistory]);

  const parsed: HttpFile = useMemo(() => (source ? parseHttpFile(source) : { variables: {}, requests: [] }), [source]);
  const requests = scratch ? [scratchToRequest(draft)] : parsed.requests;
  const fileVars = scratch ? {} : parsed.variables;
  const current = requests[Math.min(selected, Math.max(0, requests.length - 1))];

  const resolve = (req: HttpRequest) => resolveRequest(req, fileVars, envs, env);

  const send = async (req: HttpRequest, index: number) => {
    setSelected(index);
    setNotice(null);
    const { resolved, missing } = resolve(req);
    if (missing.length) {
      setError(`{{${missing[0]}}} has no value${env ? ` in "${env}"` : ""}`);
      setResponse(null);
      return;
    }
    if (!resolved.url) {
      setError("Enter a URL");
      return;
    }
    const id = newId();
    cancelRef.current = id;
    setSendingId(id);
    setError(null);
    try {
      const r = await call<HttpResponse>("/send", { method: "POST", body: JSON.stringify({ id, ...resolved }) });
      if (cancelRef.current !== id) return;
      setResponse(r);
      setLastId(id);
      // History keeps a body up to 1 MB; a bigger one is listed without it.
      const keepBody = !r.truncated && r.bodyBase64.length <= HISTORY_BODY_BASE64;
      void call("/history", {
        method: "POST",
        body: JSON.stringify({
          key: historyKey,
          entry: {
            at: Date.now(),
            method: resolved.method,
            url: resolved.url,
            status: r.status,
            timeMs: r.timeMs,
            sizeBytes: r.sizeBytes,
            contentType: r.contentType,
            headers: r.headers,
            ...(keepBody ? { bodyBase64: r.bodyBase64 } : {}),
          },
        }),
      })
        .then(loadHistory)
        .catch(() => {});
    } catch (err) {
      if (cancelRef.current !== id) return;
      setResponse(null);
      setError((err as Error).message);
      void call("/history", {
        method: "POST",
        body: JSON.stringify({ key: historyKey, entry: { at: Date.now(), method: resolved.method, url: resolved.url, error: (err as Error).message } }),
      })
        .then(loadHistory)
        .catch(() => {});
    } finally {
      if (cancelRef.current === id) setSendingId(null);
    }
  };

  const cancel = () => {
    if (!sendingId) return;
    void call("/cancel", { method: "POST", body: JSON.stringify({ id: sendingId }) });
  };

  const saveResponse = async () => {
    if (!lastId || !response) return;
    const ext = /json/.test(response.contentType) ? "json" : /html/.test(response.contentType) ? "html" : response.contentType.startsWith("image/") ? response.contentType.split("/")[1].split(";")[0] : "txt";
    const target = await host.app?.promptDialog?.("Save the response body to", `${baseDir}/response-${Date.now()}.${ext}`);
    if (!target) return;
    try {
      const { path } = await call<{ path: string }>("/save-response", { method: "POST", body: JSON.stringify({ id: lastId, path: target }) });
      setNotice(`Saved to ${path}`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409 && (await host.app?.confirmDialog?.(`${target} already exists. Replace it?`, "Replace"))) {
        const { path } = await call<{ path: string }>("/save-response", { method: "POST", body: JSON.stringify({ id: lastId, path: target, overwrite: true }) });
        setNotice(`Saved to ${path}`);
      } else {
        setError((err as Error).message);
      }
    }
  };

  const copyCurl = () => {
    if (!current) return;
    void copy(toCurl(resolve(current).resolved)).then(() => setNotice("Copied as curl"));
  };

  const saveScratch = async () => {
    const target = await host.app?.promptDialog?.("Add this request to the .http file", `${baseDir}/.perch/requests.http`);
    if (!target) return;
    try {
      const { path } = await call<{ path: string }>("/append", { method: "POST", body: JSON.stringify({ path: target, text: formatRequest(scratchToRequest(draft)) }) });
      setNotice(`Added to ${path}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const pasteCurl = (text: string): boolean => {
    const parsedCurl = fromCurl(text);
    if (!parsedCurl) return false;
    setDraft({ method: parsedCurl.method, url: parsedCurl.url, headers: parsedCurl.headers.map(([k, v]) => `${k}: ${v}`).join("\n"), body: parsedCurl.body });
    setNotice("Filled in from the curl command");
    return true;
  };

  const showFromHistory = (h: HistoryEntry) => {
    setShowHistory(false);
    if (h.error) {
      setResponse(null);
      setError(h.error);
      return;
    }
    setError(null);
    setLastId(null);
    setNotice(!h.bodyBase64 && (h.sizeBytes ?? 0) > 0 ? "History keeps bodies up to 1 MB; this one wasn't kept." : null);
    setResponse({
      status: h.status ?? 0,
      statusText: "",
      headers: h.headers ?? [],
      contentType: h.contentType ?? "",
      timeMs: h.timeMs ?? 0,
      sizeBytes: h.sizeBytes ?? 0,
      truncated: false,
      bodyBase64: h.bodyBase64 ?? "",
      url: h.url,
    });
  };

  const names = environmentNames(envs);
  const missingFor = (req: HttpRequest) => new Set(resolve(req).missing);

  const toolbar = (
    <>
      {!scratch && (
        <button className="icon-button" title="Open in Editor" onClick={() => host.app?.openFileTab?.(filePath)}>
          <span className="codicon codicon-file-code" aria-hidden="true" />
        </button>
      )}
      {!scratch && (
        <button className="icon-button" title="Reload" onClick={loadFile}>
          <span className="codicon codicon-refresh" aria-hidden="true" />
        </button>
      )}
    </>
  );

  return (
    <div className={`http-client${active ? "" : " hidden"}`}>
      {active && toolbarTarget && createPortal(toolbar, toolbarTarget)}
      <div className="hc-toolbar">
        <span className="hc-title">{scratch ? "New request" : filePath.split(/[\\/]/).pop()}</span>
        <label className="hc-env">
          env:
          <select value={env ?? ""} onChange={(e) => setEnv(e.target.value || null)} aria-label="Environment">
            {names.length === 0 && <option value="">none</option>}
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {scratch && (
          <button className="hc-button" onClick={() => void saveScratch()} disabled={!draft.url.trim()}>
            Save…
          </button>
        )}
        <div className="hc-history-wrap">
          <button className="hc-button" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
            History
          </button>
          {showHistory && (
            <div className="hc-history" role="menu">
              {history.length === 0 && <div className="hc-muted hc-pad">No requests sent yet.</div>}
              {history.map((h, i) => (
                <button key={i} role="menuitem" className="hc-history-row" onClick={() => showFromHistory(h)}>
                  <span className={`hc-status ${h.error ? "bad" : (h.status ?? 0) >= 400 ? "warn" : "ok"}`}>{h.error ? "ERR" : h.status}</span>
                  <span className="hc-history-req">
                    {h.method} {h.url}
                  </span>
                  <span className="hc-meta">{new Date(h.at).toLocaleTimeString()}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="hc-body">
        <div className="hc-requests">
          {loadError && <div className="hc-error hc-pad">Couldn't read the file: {loadError}</div>}
          {scratch ? (
            <div className="hc-scratch">
              <div className="hc-url-row">
                <select value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value })} aria-label="Method">
                  {METHODS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
                <input
                  className="hc-input"
                  placeholder="https://… or paste a curl command"
                  aria-label="URL"
                  value={draft.url}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                  onPaste={(e) => {
                    const text = e.clipboardData.getData("text");
                    if (text.trim().startsWith("curl ") && pasteCurl(text)) e.preventDefault();
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") void send(scratchToRequest(draft), 0);
                  }}
                />
                {sendingId ? (
                  <button className="hc-button" onClick={cancel}>
                    Cancel
                  </button>
                ) : (
                  <button className="hc-button primary" onClick={() => void send(scratchToRequest(draft), 0)}>
                    Send
                  </button>
                )}
              </div>
              <label className="hc-field">
                Headers <span className="hc-muted">one per line, Name: value</span>
                <textarea rows={4} value={draft.headers} onChange={(e) => setDraft({ ...draft, headers: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
              </label>
              <label className="hc-field">
                Body
                <textarea rows={8} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
              </label>
            </div>
          ) : source !== null && requests.length === 0 ? (
            <div className="hc-muted hc-pad">This file has no requests yet. Write one as METHOD URL, then headers and a body.</div>
          ) : (
            requests.map((req, i) => {
              const missing = missingFor(req);
              return (
                <div key={i} className={`hc-request${i === selected ? " selected" : ""}`} onClick={() => setSelected(i)}>
                  <div className="hc-request-head">
                    {sendingId && i === selected ? (
                      <button className="hc-send" onClick={(e) => (e.stopPropagation(), cancel())}>
                        <span className="codicon codicon-debug-stop" aria-hidden="true" /> Cancel
                      </button>
                    ) : (
                      <button className="hc-send" onClick={(e) => (e.stopPropagation(), void send(req, i))}>
                        <span className="codicon codicon-play" aria-hidden="true" /> Send
                      </button>
                    )}
                    {req.name && <span className="hc-name"># @name {req.name}</span>}
                  </div>
                  <pre className="hc-request-text">
                    <span className="hc-method">{req.method}</span> <Highlighted text={req.url} missing={missing} />
                    {req.headers.map(([k, v], j) => (
                      <span key={j}>
                        {"\n"}
                        <span className="hc-header-name">{k}</span>: <Highlighted text={v} missing={missing} />
                      </span>
                    ))}
                    {req.body && (
                      <>
                        {"\n\n"}
                        <Highlighted text={req.body} missing={missing} />
                      </>
                    )}
                  </pre>
                </div>
              );
            })
          )}
        </div>
        <div className="hc-side">
          <div className="hc-side-actions">
            <button className="hc-button" onClick={copyCurl} disabled={!current}>
              Copy as curl
            </button>
            <button className="hc-button" onClick={() => void saveResponse()} disabled={!response || !lastId}>
              Save Response…
            </button>
            {response && (
              <span className="hc-meta" title={response.url}>
                {formatSize(response.sizeBytes)}
              </span>
            )}
          </div>
          {notice && <div className="hc-notice">{notice}</div>}
          {error ? (
            <div className="hc-error hc-pad">{error}</div>
          ) : sendingId ? (
            <div className="hc-muted hc-pad">Sending…</div>
          ) : response ? (
            <ResponseView response={response} />
          ) : (
            <div className="hc-muted hc-pad">Send a request to see its response here.</div>
          )}
        </div>
      </div>
    </div>
  );
}
