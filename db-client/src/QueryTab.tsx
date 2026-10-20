import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ApiError,
  call,
  connectionIdOfTab,
  ENGINE_LABELS,
  getConnections,
  pendingTabs,
  refreshConnections,
  subscribeConnections,
  toggleWritable,
  type Connection,
  type RowsResult,
  type TabStart,
} from "./host";
import { ResultsGrid, download, toCsv, toJson } from "./ResultsGrid";

type MongoResult = { kind: "docs"; docs: unknown[]; truncated: boolean; rowCount: number; timeMs: number; limit: number };
type RedisReply = { kind: "redis"; reply: unknown; timeMs: number };
type Result = RowsResult | MongoResult | RedisReply;

function newQueryId(): string {
  return Math.random().toString(36).slice(2, 12);
}

function useConnection(id: string): Connection | null | undefined {
  const list = useSyncExternalStore(subscribeConnections, getConnections);
  useEffect(() => {
    if (!list) void refreshConnections().catch(() => {});
  }, [list]);
  if (!list) return undefined;
  return list.find((c) => c.id === id) ?? null;
}

function ModePill({ conn }: { conn: Connection }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        className={`db-pill ${conn.writable ? "writable" : "readonly"}`}
        title={conn.writable ? "Writable: queries can change data. Click to make it read-only." : "Read-only: click to make it writable"}
        onClick={() => toggleWritable(conn).catch((err: Error) => setError(err.message))}
      >
        {conn.writable ? "writable" : "read-only"}
      </button>
      {error && <span className="db-error">{error}</span>}
    </>
  );
}

function Footer({ result, onExport }: { result: RowsResult | MongoResult; onExport?: (kind: "csv" | "json") => void }) {
  const shown = result.kind === "rows" ? result.rows.length : result.docs.length;
  return (
    <div className="db-footer">
      <span>
        {result.truncated ? `Showing the first ${result.limit.toLocaleString("en-US")} ${result.kind === "rows" ? "rows" : "documents"}` : `${shown.toLocaleString("en-US")} ${result.kind === "rows" ? (shown === 1 ? "row" : "rows") : shown === 1 ? "document" : "documents"}`} · {result.timeMs} ms
      </span>
      {result.kind === "rows" && result.notes.length > 0 && <span className="db-notes">{result.notes.join(" · ")}</span>}
      {onExport && shown > 0 && (
        <span className="db-export">
          Export
          <button className="db-link" onClick={() => onExport("csv")}>
            CSV
          </button>
          <button className="db-link" onClick={() => onExport("json")}>
            JSON
          </button>
        </span>
      )}
    </div>
  );
}

// ---- SQL ----

function SqlTab({ conn, start, active }: { conn: Connection; start: TabStart; active: boolean }) {
  const [text, setText] = useState(start.text ?? "");
  const [result, setResult] = useState<RowsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [history, setHistory] = useState<{ at: number; text: string }[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const run = useCallback(
    async (sql: string) => {
      if (!sql.trim()) return;
      const queryId = newQueryId();
      setRunning(queryId);
      setError(null);
      try {
        setResult(await call<RowsResult>("/query", { method: "POST", body: JSON.stringify({ id: conn.id, queryId, text: sql }) }));
      } catch (err) {
        setResult(null);
        setError((err as Error).message);
      } finally {
        setRunning((r) => (r === queryId ? null : r));
      }
    },
    [conn.id],
  );

  useEffect(() => {
    if (start.run && start.text) void run(start.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCurrent = () => {
    const el = ref.current;
    const selected = el && el.selectionEnd > el.selectionStart ? text.slice(el.selectionStart, el.selectionEnd) : "";
    void run(selected.trim() ? selected : text);
  };

  const cancel = () => {
    if (running) void call("/cancel", { method: "POST", body: JSON.stringify({ queryId: running }) });
  };

  const loadHistory = () => {
    setShowHistory((v) => !v);
    call<{ entries: { at: number; text: string }[] }>(`/history?id=${conn.id}`)
      .then((d) => setHistory(d.entries))
      .catch(() => {});
  };

  const exportAs = (kind: "csv" | "json") => {
    if (!result) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    if (kind === "csv") download(`${conn.name}-${stamp}.csv`, toCsv(result.columns, result.rows), "text/csv");
    else download(`${conn.name}-${stamp}.json`, toJson(result.columns, result.rows), "application/json");
  };

  return (
    <div className={`db-tab${active ? "" : " hidden"}`}>
      <div className="db-toolbar">
        <span className="db-conn-name">{conn.name}</span>
        <span className="db-engine">{ENGINE_LABELS[conn.engine]}</span>
        <ModePill conn={conn} />
        <span className="db-spacer" />
        <div className="db-history-wrap">
          <button className="db-button" onClick={loadHistory} aria-expanded={showHistory}>
            History
          </button>
          {showHistory && (
            <div className="db-history" role="menu">
              {history.length === 0 && <div className="db-muted db-pad">No queries yet.</div>}
              {history.map((h, i) => (
                <button
                  key={i}
                  role="menuitem"
                  className="db-history-row"
                  onClick={() => {
                    setText(h.text);
                    setShowHistory(false);
                  }}
                >
                  <span className="db-history-text">{h.text}</span>
                  <span className="db-muted">{new Date(h.at).toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {running ? (
          <button className="db-button" onClick={cancel}>
            <span className="codicon codicon-debug-stop" aria-hidden="true" /> Cancel
          </button>
        ) : (
          <button className="db-button primary" onClick={runCurrent} title="Run the selection, or everything (Ctrl+Enter)">
            <span className="codicon codicon-play" aria-hidden="true" /> Run
          </button>
        )}
      </div>
      <textarea
        ref={ref}
        className="db-editor"
        spellCheck={false}
        value={text}
        placeholder="SELECT … (Ctrl+Enter runs the selection, or everything)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            runCurrent();
          }
        }}
      />
      <div className="db-results">
        {error ? (
          <div className="db-error db-pad">{error}</div>
        ) : running ? (
          <div className="db-muted db-pad">Running…</div>
        ) : result ? (
          <>
            {result.columns.length > 0 ? <ResultsGrid columns={result.columns} rows={result.rows} /> : <div className="db-muted db-pad">Done.</div>}
            <Footer result={result} onExport={result.columns.length ? exportAs : undefined} />
          </>
        ) : (
          <div className="db-muted db-pad">Run a query to see its results here.</div>
        )}
      </div>
    </div>
  );
}

// ---- MongoDB ----

function MongoTab({ conn, start, active }: { conn: Connection; start: TabStart; active: boolean }) {
  const [db, setDb] = useState(start.db ?? conn.database ?? "");
  const [collection, setCollection] = useState(start.collection ?? "");
  const [mode, setMode] = useState<"find" | "aggregate">("find");
  const [filter, setFilter] = useState("{}");
  const [projection, setProjection] = useState("");
  const [sort, setSort] = useState("");
  const [pipeline, setPipeline] = useState('[\n  { "$match": {} },\n  { "$limit": 20 }\n]');
  const [view, setView] = useState<"docs" | "table">("docs");
  const [result, setResult] = useState<MongoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const run = async () => {
    const queryId = newQueryId();
    setRunning(queryId);
    setError(null);
    try {
      const spec = { db, collection, mode, filter, projection, sort, pipeline };
      setResult(await call<MongoResult>("/query", { method: "POST", body: JSON.stringify({ id: conn.id, queryId, spec }) }));
    } catch (err) {
      setResult(null);
      setError((err as Error).message);
    } finally {
      setRunning((r) => (r === queryId ? null : r));
    }
  };

  useEffect(() => {
    if (start.run && start.collection) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const keys = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void run();
    }
  };

  const columns = result ? [...new Set(result.docs.flatMap((d) => Object.keys((d ?? {}) as object)))] : [];

  return (
    <div className={`db-tab${active ? "" : " hidden"}`}>
      <div className="db-toolbar">
        <span className="db-conn-name">{conn.name}</span>
        <span className="db-engine">MongoDB</span>
        <ModePill conn={conn} />
        <span className="db-spacer" />
        {running ? (
          <button className="db-button" onClick={() => void call("/cancel", { method: "POST", body: JSON.stringify({ queryId: running }) })}>
            Cancel
          </button>
        ) : (
          <button className="db-button primary" onClick={() => void run()}>
            <span className="codicon codicon-play" aria-hidden="true" /> Run
          </button>
        )}
      </div>
      <div className="db-mongo-bar">
        <label>
          Database <input value={db} onChange={(e) => setDb(e.target.value)} onKeyDown={keys} />
        </label>
        <label>
          Collection <input value={collection} onChange={(e) => setCollection(e.target.value)} onKeyDown={keys} />
        </label>
        <select value={mode} onChange={(e) => setMode(e.target.value as "find" | "aggregate")} aria-label="Query kind">
          <option value="find">find</option>
          <option value="aggregate">aggregate</option>
        </select>
      </div>
      {mode === "find" ? (
        <div className="db-mongo-fields">
          <label>
            Filter <input className="db-mono" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={keys} placeholder='{ "status": "active" }' />
          </label>
          <label>
            Projection <input className="db-mono" value={projection} onChange={(e) => setProjection(e.target.value)} onKeyDown={keys} placeholder='{ "name": 1 }' />
          </label>
          <label>
            Sort <input className="db-mono" value={sort} onChange={(e) => setSort(e.target.value)} onKeyDown={keys} placeholder='{ "createdAt": -1 }' />
          </label>
        </div>
      ) : (
        <textarea className="db-editor db-pipeline" spellCheck={false} value={pipeline} onChange={(e) => setPipeline(e.target.value)} onKeyDown={keys} />
      )}
      <div className="db-results">
        {error ? (
          <div className="db-error db-pad">{error}</div>
        ) : running ? (
          <div className="db-muted db-pad">Running…</div>
        ) : result ? (
          <>
            <div className="db-view-toggle">
              <button className={view === "docs" ? "active" : ""} onClick={() => setView("docs")}>
                Documents
              </button>
              <button className={view === "table" ? "active" : ""} onClick={() => setView("table")}>
                Table
              </button>
            </div>
            {view === "docs" ? (
              <div className="db-docs">
                {result.docs.map((d, i) => (
                  <pre key={i} className="db-doc">
                    {JSON.stringify(d, null, 2)}
                  </pre>
                ))}
              </div>
            ) : (
              <ResultsGrid
                columns={columns.map((c) => ({ name: c, type: "" }))}
                rows={result.docs.map((d) => columns.map((c) => ((d ?? {}) as Record<string, unknown>)[c] ?? null))}
              />
            )}
            <Footer
              result={result}
              onExport={(kind) => {
                const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
                if (kind === "json") download(`${collection}-${stamp}.json`, JSON.stringify(result.docs, null, 2), "application/json");
                else
                  download(
                    `${collection}-${stamp}.csv`,
                    toCsv(columns.map((c) => ({ name: c })), result.docs.map((d) => columns.map((c) => ((d ?? {}) as Record<string, unknown>)[c] ?? null))),
                    "text/csv",
                  );
              }}
            />
          </>
        ) : (
          <div className="db-muted db-pad">Choose a collection and run a query.</div>
        )}
      </div>
    </div>
  );
}

// ---- Redis ----

interface RedisKey {
  key: string;
  type: string;
}

interface RedisValue {
  key: string;
  type: string;
  ttl: number;
  length: number | null;
  value: unknown;
}

function RedisValueView({ value }: { value: RedisValue }) {
  const v = value.value;
  let body: React.ReactNode;
  if (value.type === "hash" && v && typeof v === "object") {
    const entries = Array.isArray(v) ? [] : Object.entries(v as Record<string, unknown>);
    body = <ResultsGrid columns={[{ name: "field", type: "" }, { name: "value", type: "" }]} rows={entries.map(([k, x]) => [k, x])} />;
  } else if (value.type === "zset" && Array.isArray(v)) {
    const rows: unknown[][] = [];
    for (let i = 0; i < v.length; i += 2) rows.push([v[i], v[i + 1]]);
    body = <ResultsGrid columns={[{ name: "member", type: "" }, { name: "score", type: "" }]} rows={rows} />;
  } else if ((value.type === "list" || value.type === "set") && Array.isArray(v)) {
    body = <ResultsGrid columns={[{ name: value.type === "list" ? "item" : "member", type: "" }]} rows={v.map((x) => [x])} />;
  } else if (value.type === "string") {
    let pretty = String(v ?? "");
    try {
      pretty = JSON.stringify(JSON.parse(pretty), null, 2);
    } catch {
      // not JSON
    }
    body = <pre className="db-doc">{pretty}</pre>;
  } else {
    body = <pre className="db-doc">{JSON.stringify(v, null, 2)}</pre>;
  }
  return (
    <div className="db-redis-value">
      <div className="db-redis-meta">
        <span className="db-mono">{value.key}</span>
        <span className="db-tag">{value.type}</span>
        {value.length !== null && <span className="db-muted">{value.length} items</span>}
        <span className="db-muted">TTL {value.ttl < 0 ? "none" : `${value.ttl} s`}</span>
      </div>
      {body}
    </div>
  );
}

function RedisTab({ conn, start, active }: { conn: Connection; start: TabStart; active: boolean }) {
  const [pattern, setPattern] = useState(start.pattern ?? "*");
  const [keys, setKeys] = useState<RedisKey[] | null>(null);
  const [selected, setSelected] = useState<RedisValue | null>(null);
  const [command, setCommand] = useState("");
  const [consoleLog, setConsoleLog] = useState<{ cmd: string; out: string; error?: boolean }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(() => {
    setError(null);
    call<{ keys: RedisKey[] }>(`/redis/keys?id=${conn.id}&pattern=${encodeURIComponent(pattern || "*")}`)
      .then((d) => setKeys(d.keys))
      .catch((err: Error) => setError(err.message));
  }, [conn.id, pattern]);

  useEffect(() => scan(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (key: string) =>
    call<RedisValue>(`/redis/value?id=${conn.id}&key=${encodeURIComponent(key)}`)
      .then(setSelected)
      .catch((err: Error) => setError(err.message));

  const runCommand = async () => {
    const cmd = command.trim();
    if (!cmd) return;
    setCommand("");
    try {
      const r = await call<RedisReply>("/query", { method: "POST", body: JSON.stringify({ id: conn.id, queryId: newQueryId(), text: cmd }) });
      setConsoleLog((log) => [...log, { cmd, out: typeof r.reply === "string" ? r.reply : JSON.stringify(r.reply, null, 2) }].slice(-50));
    } catch (err) {
      setConsoleLog((log) => [...log, { cmd, out: (err as Error).message, error: true }].slice(-50));
    }
  };

  return (
    <div className={`db-tab${active ? "" : " hidden"}`}>
      <div className="db-toolbar">
        <span className="db-conn-name">{conn.name}</span>
        <span className="db-engine">Redis</span>
        <ModePill conn={conn} />
        <span className="db-spacer" />
        <input
          className="db-input db-mono"
          aria-label="Key pattern"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") scan();
          }}
        />
        <button className="db-button" onClick={scan}>
          Scan
        </button>
      </div>
      {error && <div className="db-error db-pad">{error}</div>}
      <div className="db-redis">
        <div className="db-redis-keys">
          {keys === null ? (
            <div className="db-muted db-pad">Scanning…</div>
          ) : keys.length === 0 ? (
            <div className="db-muted db-pad">No keys match {pattern}.</div>
          ) : (
            keys.map((k) => (
              <button key={k.key} className={`db-redis-key${selected?.key === k.key ? " selected" : ""}`} onClick={() => void open(k.key)}>
                <span className="db-tag">{k.type}</span>
                <span className="db-mono">{k.key}</span>
              </button>
            ))
          )}
        </div>
        <div className="db-redis-side">{selected ? <RedisValueView value={selected} /> : <div className="db-muted db-pad">Select a key to see its value.</div>}</div>
      </div>
      <div className="db-console">
        <div className="db-console-log">
          {consoleLog.map((l, i) => (
            <div key={i}>
              <div className="db-mono db-console-cmd">&gt; {l.cmd}</div>
              <pre className={l.error ? "db-error" : undefined}>{l.out}</pre>
            </div>
          ))}
        </div>
        <input
          className="db-input db-mono"
          placeholder="Redis command, such as HGETALL user:1"
          aria-label="Redis command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void runCommand();
          }}
        />
      </div>
    </div>
  );
}

export function QueryTab({ filePath, active }: { filePath: string; active: boolean }) {
  const id = connectionIdOfTab(filePath);
  const conn = useConnection(id);
  const [start] = useState<TabStart>(() => {
    const s = pendingTabs.get(filePath) ?? {};
    pendingTabs.delete(filePath);
    return s;
  });
  if (conn === undefined) return <div className={`db-tab db-muted db-pad${active ? "" : " hidden"}`}>Loading…</div>;
  if (conn === null) return <div className={`db-tab db-muted db-pad${active ? "" : " hidden"}`}>This connection was removed.</div>;
  if (conn.engine === "mongo") return <MongoTab conn={conn} start={start} active={active} />;
  if (conn.engine === "redis") return <RedisTab conn={conn} start={start} active={active} />;
  return <SqlTab conn={conn} start={start} active={active} />;
}

export { ApiError };
