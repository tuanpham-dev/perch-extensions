import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fromCurl, toCurl } from "./curl";
import { call, host, HttpError, pendingScratch, type HistoryEntry, type HttpResponse } from "./host";
import {
  chainedNames,
  environmentNames,
  formatRequest,
  mergeEnvironments,
  parseHttpFile,
  resolveRequest,
  resolveText,
  serverVariableNames,
  type Environments,
  type HttpFile,
  type HttpRequest,
  type NamedExchange,
  type ResolveContext,
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

// The last exchange of each named request, per file, for {{name.response.…}}.
// Module-level so it outlives the tab being closed and reopened.
const namedExchanges = new Map<string, Record<string, NamedExchange>>();

function exchangesFor(key: string): Record<string, NamedExchange> {
  let found = namedExchanges.get(key);
  if (!found) namedExchanges.set(key, (found = {}));
  return found;
}

function decodeBody(base64: string): string {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// A path from a .http file against the file's folder ("~" and absolute
// paths as they are), for reading a "<@ ./file" body.
function joinPath(dir: string, p: string): string {
  if (p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:[\\/]/.test(p)) return p;
  return `${dir.replace(/[\\/]+$/, "")}/${p.replace(/^\.[\\/]/, "")}`;
}

// Everything in a request that can hold a {{variable}}.
function requestText(req: HttpRequest): string {
  return [req.url, ...req.headers.flat(), req.body, req.bodyFile ?? ""].join("\n");
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
  const [historyQuery, setHistoryQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // Env files that exist but couldn't be read, shown above the requests.
  const [envErrors, setEnvErrors] = useState<{ file: string; error: string }[]>([]);
  const [serverVars, setServerVars] = useState<{ dotenv: Record<string, string>; processEnv: Record<string, string> }>({ dotenv: {}, processEnv: {} });
  // Bumped when a named request's response arrives, so {{name.response…}}
  // highlighting catches up.
  const [, setExchangeVersion] = useState(0);
  const historyKey = scratch ? "scratch" : filePath;
  const baseDir = scratch ? (host.app?.getActiveContext().cwd ?? "") : dirOf(filePath);
  const cancelRef = useRef<string | null>(null);
  // The send in flight, which may be a request a chained one reads from.
  const inFlightRef = useRef<string | null>(null);

  // Counts file reads, so the env files are read again on every Reload or
  // return to the tab even when the .http text itself didn't change.
  const [reads, setReads] = useState(0);
  const loadFile = useCallback(() => {
    if (scratch) return;
    fetch(`/api/download?path=${encodeURIComponent(filePath)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((text) => {
        setSource(text);
        setLoadError(null);
        setReads((n) => n + 1);
      })
      .catch((err: Error) => setLoadError(err.message));
  }, [filePath, scratch]);

  useEffect(() => loadFile(), [loadFile, reloadKey]);
  useEffect(() => {
    if (active) loadFile();
  }, [active, loadFile]);

  // The server-side values the file asks for by name ({{$dotenv X}},
  // {{$processEnv Y}}), fetched along with the environments.
  const wanted = useMemo(() => serverVariableNames(scratch ? `${draft.url}\n${draft.headers}\n${draft.body}` : (source ?? "")), [scratch, draft, source]);
  const wantedKey = `${wanted.dotenv.join(",")}|${wanted.processEnv.join(",")}`;
  useEffect(() => {
    if (!baseDir) return;
    const params = new URLSearchParams({ dir: baseDir, dotenv: wanted.dotenv.join(","), processEnv: wanted.processEnv.join(",") });
    call<{ shared: Environments; private: Environments; dotenv?: Record<string, string>; processEnv?: Record<string, string>; errors?: { file: string; error: string }[] }>(`/env?${params}`)
      .then((d) => {
        const merged = mergeEnvironments(d.shared, d.private);
        setEnvs(merged);
        setServerVars({ dotenv: d.dotenv ?? {}, processEnv: d.processEnv ?? {} });
        setEnvErrors(d.errors ?? []);
        const names = environmentNames(merged);
        setEnv((current) => (current && names.includes(current) ? current : (names[0] ?? null)));
      })
      .catch((err: Error) => setEnvErrors([{ file: "environments", error: err.message }]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseDir, source, wantedKey, reads]);

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

  const exchanges = exchangesFor(historyKey);
  const context = (): ResolveContext => ({ ...serverVars, named: exchanges });
  const resolve = (req: HttpRequest) => resolveRequest(req, fileVars, envs, env, context());

  const record = (entry: Record<string, unknown>) =>
    void call("/history", { method: "POST", body: JSON.stringify({ key: historyKey, entry: { at: Date.now(), ...entry } }) })
      .then(loadHistory)
      .catch(() => {});

  // Sends one request and records it; throws with a message to show. The
  // named requests it reads from that haven't answered yet go first, so
  // {{login.response.body.$.token}} works on the first Send.
  const transmit = async (req: HttpRequest, chain: string[], run: string): Promise<{ response: HttpResponse; id: string }> => {
    for (const name of chainedNames(requestText(req))) {
      if (exchanges[name] || name === req.name) continue;
      const dep = requests.find((r) => r.name === name);
      if (!dep) continue; // left for resolve to report as missing
      if (chain.includes(name)) throw new Error(`These requests read from each other: ${[...chain, name].join(" → ")}`);
      setNotice(`Sending ${name} first…`);
      await transmit(dep, [...chain, name], run);
    }
    const { resolved, missing } = resolve(req);
    if (missing.length) throw new Error(`{{${missing[0]}}} has no value${env ? ` in "${env}"` : ""}${chain.length ? ` (in ${req.name ?? "a request"})` : ""}`);
    if (!resolved.url) throw new Error("Enter a URL");
    let body = resolved.body;
    let bodyFile = resolved.bodyFile;
    // "<@ ./file": the file's text with its own {{variables}} filled.
    if (bodyFile && req.bodyFileVars) {
      const path = joinPath(baseDir, bodyFile);
      const r = await fetch(`/api/download?path=${encodeURIComponent(path)}`);
      if (!r.ok) throw new Error(`Couldn't read the body file ${path} (${r.status})`);
      const fileMissing = new Set<string>();
      body = resolveText(await r.text(), fileVars, envs, env, fileMissing, context());
      if (fileMissing.size) throw new Error(`{{${[...fileMissing][0]}}} in ${bodyFile} has no value`);
      bodyFile = undefined;
    }
    // Cancel pressed while an earlier step ran: send nothing more.
    if (cancelRef.current !== run) throw new Error("Cancelled");
    const id = newId();
    inFlightRef.current = id;
    try {
      const r = await call<HttpResponse>("/send", {
        method: "POST",
        body: JSON.stringify({ id, ...resolved, body, bodyFile, baseDir }),
      });
      if (req.name) {
        exchanges[req.name] = {
          request: { headers: resolved.headers, body },
          response: { headers: r.headers, body: decodeBody(r.bodyBase64) },
        };
        setExchangeVersion((v) => v + 1);
      }
      // History keeps a body up to 1 MB; a bigger one is listed without it.
      const keepBody = !r.truncated && r.bodyBase64.length <= HISTORY_BODY_BASE64;
      record({
        method: resolved.method,
        url: resolved.url,
        status: r.status,
        timeMs: r.timeMs,
        sizeBytes: r.sizeBytes,
        contentType: r.contentType,
        headers: r.headers,
        ...(keepBody ? { bodyBase64: r.bodyBase64 } : {}),
      });
      return { response: r, id };
    } catch (err) {
      record({ method: resolved.method, url: resolved.url, error: (err as Error).message });
      throw err;
    } finally {
      if (inFlightRef.current === id) inFlightRef.current = null;
    }
  };

  const send = async (req: HttpRequest, index: number) => {
    if (sendingId) return;
    setSelected(index);
    setNotice(null);
    const run = newId();
    cancelRef.current = run;
    setSendingId(run);
    setError(null);
    try {
      const { response: r, id } = await transmit(req, req.name ? [req.name] : [], run);
      if (cancelRef.current !== run) return;
      setNotice(null);
      setResponse(r);
      setLastId(id);
    } catch (err) {
      if (cancelRef.current !== run) return;
      setNotice(null);
      setResponse(null);
      setError((err as Error).message);
    } finally {
      if (cancelRef.current === run) setSendingId(null);
    }
  };

  // Stops the send in flight (the server deletes anything it had spooled)
  // and, for a chain, every step after it.
  const cancel = () => {
    if (!sendingId) return;
    if (inFlightRef.current) void call("/cancel", { method: "POST", body: JSON.stringify({ id: inFlightRef.current }) });
    cancelRef.current = null;
    setSendingId(null);
    setNotice(null);
    setResponse(null);
    setError("Cancelled");
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

  const clearHistory = async () => {
    if (!(await host.app?.confirmDialog?.(scratch ? "Delete the history of scratch requests?" : "Delete this file's request history?", "Delete"))) return;
    try {
      await call("/history/clear", { method: "POST", body: JSON.stringify({ key: historyKey }) });
      setHistory([]);
      setHistoryQuery("");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const shownHistory = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
    if (!q) return history;
    return history.filter((h) => `${h.method} ${h.url} ${h.error ? "error " + h.error : (h.status ?? "")}`.toLowerCase().includes(q));
  }, [history, historyQuery]);

  // Ctrl+Enter (Cmd+Enter) sends the selected request from anywhere in the tab.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (scratch) void send(scratchToRequest(draft), 0);
    else if (current) void send(current, Math.min(selected, requests.length - 1));
  };

  // The scratch fields keep their keys from the host's shortcuts, but
  // Ctrl+Enter still sends.
  const fieldKeys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onKeyDown(e);
    e.stopPropagation();
  };

  const names = environmentNames(envs);
  // A {{login.response…}} whose request is in this file but hasn't been
  // sent isn't missing: Send sends it first.
  const missingFor = (req: HttpRequest) =>
    new Set(
      resolve(req).missing.filter((expr) => {
        const name = /^([A-Za-z_][\w-]*)\.(?:request|response)\./.exec(expr)?.[1];
        return !name || exchanges[name] || !requests.some((r) => r.name === name);
      }),
    );

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
    // tabIndex -1: a click anywhere in the tab focuses it, so Ctrl+Enter
    // reaches onKeyDown without first clicking a field.
    <div className={`http-client${active ? "" : " hidden"}`} tabIndex={-1} onKeyDown={onKeyDown}>
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
              {history.length > 0 && (
                <div className="hc-history-tools">
                  <input
                    className="hc-input"
                    type="search"
                    autoFocus
                    placeholder="Search URL, method or status"
                    aria-label="Search history"
                    value={historyQuery}
                    onChange={(e) => setHistoryQuery(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Escape") setShowHistory(false);
                    }}
                  />
                  <button className="hc-button" onClick={() => void clearHistory()}>
                    Clear
                  </button>
                </div>
              )}
              {history.length === 0 && <div className="hc-muted hc-pad">No requests sent yet.</div>}
              {history.length > 0 && shownHistory.length === 0 && <div className="hc-muted hc-pad">Nothing matches.</div>}
              {shownHistory.map((h, i) => (
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
      {envErrors.map((e) => (
        <div key={e.file} className="hc-error hc-pad">
          Couldn't read {e.file}: {e.error}
        </div>
      ))}
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
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void send(scratchToRequest(draft), 0);
                    }
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
                <textarea rows={4} value={draft.headers} onChange={(e) => setDraft({ ...draft, headers: e.target.value })} onKeyDown={fieldKeys} />
              </label>
              <label className="hc-field">
                Body
                <textarea rows={8} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} onKeyDown={fieldKeys} />
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
                    {req.noRedirect && <span className="hc-name"># @no-redirect</span>}
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
                    {req.bodyFile && (
                      <>
                        {"\n\n"}
                        <span className="hc-method">{req.bodyFileVars ? "<@" : "<"}</span> <Highlighted text={req.bodyFile} missing={missing} />
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
            <div className="hc-muted hc-pad">Send a request (Ctrl+Enter) to see its response here.</div>
          )}
        </div>
      </div>
    </div>
  );
}
