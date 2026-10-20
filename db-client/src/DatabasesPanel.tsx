import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  call,
  ENGINE_LABELS,
  ENGINE_SHORT,
  getConnections,
  host,
  openQueryTab,
  refreshConnections,
  subscribeConnections,
  tableQuery,
  toggleWritable,
  type Connection,
  type Engine,
  type Schema,
} from "./host";

interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  separator?: boolean;
}

interface Suggestion {
  file: string;
  key: string;
  engine: Engine;
  display: string;
  name: string;
}

const DEFAULT_PORTS: Partial<Record<Engine, number>> = { postgres: 5432, mysql: 3306, redis: 6379, mongo: 27017 };

function AddForm({ onDone }: { onDone: () => void }) {
  const [engine, setEngine] = useState<Engine>("postgres");
  const [useUrl, setUseUrl] = useState(true);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => {
    const cwd = host.app?.getActiveContext().cwd;
    if (!cwd) return;
    call<{ suggestions: Suggestion[] }>(`/suggest?dir=${encodeURIComponent(cwd)}`)
      .then((d) => setSuggestions(d.suggestions))
      .catch(() => {});
  }, []);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setFields((f) => ({ ...f, [k]: e.target.value }));
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();

  const save = async (body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await call("/connections", { method: "POST", body: JSON.stringify(body) });
      await refreshConnections();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (useUrl && engine !== "sqlite") void save({ url: fields.url, name: fields.name });
    else void save({ engine, ...fields, port: fields.port ? Number(fields.port) : DEFAULT_PORTS[engine] });
  };

  return (
    <div className="db-add">
      {suggestions.length > 0 && (
        <div className="db-suggest">
          <div className="db-muted">Found in this project</div>
          {suggestions.map((s) => (
            <div key={`${s.file}:${s.key}`} className="db-suggest-row">
              <span className="db-mono db-suggest-text" title={s.display}>
                {s.key}: {s.display}
              </span>
              <button className="db-button" disabled={busy} onClick={() => void save({ fromEnv: { file: s.file, key: s.key } })}>
                Add
              </button>
            </div>
          ))}
        </div>
      )}
      <label className="db-field">
        Type
        <select value={engine} onChange={(e) => setEngine(e.target.value as Engine)}>
          {(Object.keys(ENGINE_LABELS) as Engine[]).map((e) => (
            <option key={e} value={e}>
              {ENGINE_LABELS[e]}
            </option>
          ))}
        </select>
      </label>
      {engine === "sqlite" ? (
        <label className="db-field">
          File <input className="db-mono" value={fields.file ?? ""} onChange={set("file")} onKeyDown={stop} placeholder="/path/to/app.db" />
        </label>
      ) : (
        <>
          <div className="db-switch">
            <button className={useUrl ? "active" : ""} onClick={() => setUseUrl(true)}>
              URL
            </button>
            <button className={useUrl ? "" : "active"} onClick={() => setUseUrl(false)}>
              Fields
            </button>
          </div>
          {useUrl ? (
            <label className="db-field">
              Connection URL
              <input
                className="db-mono"
                value={fields.url ?? ""}
                onChange={set("url")}
                onKeyDown={stop}
                placeholder={
                  engine === "postgres"
                    ? "postgres://user:password@localhost:5432/db"
                    : engine === "mysql"
                      ? "mysql://user:password@localhost:3306/db"
                      : engine === "redis"
                        ? "redis://:password@localhost:6379/0"
                        : "mongodb://user:password@localhost:27017/db"
                }
              />
            </label>
          ) : (
            <>
              <div className="db-field-row">
                <label className="db-field">
                  Host <input value={fields.host ?? ""} onChange={set("host")} onKeyDown={stop} placeholder="localhost" />
                </label>
                <label className="db-field db-port">
                  Port <input value={fields.port ?? ""} onChange={set("port")} onKeyDown={stop} placeholder={String(DEFAULT_PORTS[engine] ?? "")} />
                </label>
              </div>
              <label className="db-field">
                {engine === "redis" ? "Database number" : "Database"} <input value={fields.database ?? ""} onChange={set("database")} onKeyDown={stop} />
              </label>
              <label className="db-field">
                User <input value={fields.user ?? ""} onChange={set("user")} onKeyDown={stop} />
              </label>
              <label className="db-field">
                Password <input type="password" value={fields.password ?? ""} onChange={set("password")} onKeyDown={stop} autoComplete="new-password" />
              </label>
            </>
          )}
        </>
      )}
      <label className="db-field">
        Name <input value={fields.name ?? ""} onChange={set("name")} onKeyDown={stop} placeholder="optional" />
      </label>
      <div className="db-muted">New connections are read-only. Passwords are kept in Perch&apos;s secret store.</div>
      {error && <div className="db-error">{error}</div>}
      <div className="db-add-buttons">
        <button className="db-button" onClick={onDone}>
          Cancel
        </button>
        <button className="db-button primary" disabled={busy} onClick={submit}>
          Add Connection
        </button>
      </div>
    </div>
  );
}

function ConnectionNode({ conn, showMenu }: { conn: Connection; showMenu?: (x: number, y: number, items: MenuItem[]) => void }) {
  const [open, setOpen] = useState(false);
  const [schema, setSchema] = useState<Schema | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const load = () => {
    setError(null);
    call<Schema>(`/schema?id=${conn.id}`)
      .then((s) => {
        setSchema(s);
        if (s.groups.length === 1) setOpenGroups(new Set([s.groups[0].name]));
      })
      .catch((err: Error) => setError(err.message));
  };

  const toggle = () => {
    setOpen((v) => !v);
    if (!schema) load();
  };

  const remove = async () => {
    if (!(await host.app?.confirmDialog?.(`Remove the connection "${conn.name}"? Its saved password is removed too.`, "Remove"))) return;
    await call(`/connections/${conn.id}`, { method: "DELETE" });
    await refreshConnections();
  };

  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    showMenu?.(e.clientX, e.clientY, [
      { label: "New Query", onClick: () => openQueryTab(conn) },
      { label: "Refresh", onClick: load },
      { label: conn.writable ? "Make Read-Only" : "Make Writable…", onClick: () => void toggleWritable(conn) },
      { label: "", separator: true, onClick: () => {} },
      { label: "Remove Connection…", danger: true, onClick: () => void remove() },
    ]);
  };

  const openTable = (group: string, table: { name: string; kind: string }) => {
    if (conn.engine === "mongo") openQueryTab(conn, { db: group, collection: table.name, run: true }, table.name);
    else if (conn.engine === "redis") openQueryTab(conn, { pattern: table.name === "(no prefix)" ? "*" : table.name }, table.name);
    else openQueryTab(conn, { text: tableQuery(conn.engine, group, table.name), run: true }, table.name);
  };

  return (
    <div className="db-node">
      <button className="db-row db-conn-row" onClick={toggle} onContextMenu={menu} aria-expanded={open}>
        <span className={`codicon codicon-chevron-${open ? "down" : "right"}`} aria-hidden="true" />
        <span className="db-row-name">{conn.name}</span>
        <span className="db-engine-tag">{ENGINE_SHORT[conn.engine]}</span>
        {conn.writable && <span className="db-writable-tag">writable</span>}
      </button>
      {open && (
        <div className="db-children">
          {error && <div className="db-error db-indent">{error}</div>}
          {!schema && !error && <div className="db-muted db-indent">Connecting…</div>}
          {schema?.groups.map((g) => {
            const gOpen = openGroups.has(g.name);
            return (
              <div key={g.name}>
                <button
                  className="db-row db-group-row"
                  aria-expanded={gOpen}
                  onClick={() =>
                    setOpenGroups((prev) => {
                      const next = new Set(prev);
                      if (next.has(g.name)) next.delete(g.name);
                      else next.add(g.name);
                      return next;
                    })
                  }
                >
                  <span className={`codicon codicon-chevron-${gOpen ? "down" : "right"}`} aria-hidden="true" />
                  <span className="codicon codicon-database" aria-hidden="true" />
                  <span className="db-row-name">{g.name}</span>
                  <span className="db-muted">{g.children.length}</span>
                </button>
                {gOpen &&
                  (g.children.length === 0 ? (
                    <div className="db-muted db-indent2">Empty</div>
                  ) : (
                    g.children.map((t) => (
                      <button key={t.name} className="db-row db-table-row" onClick={() => openTable(g.name, t)} title={t.columns.map((c) => `${c.name} ${c.type}`).join("\n")}>
                        <span
                          className={`codicon codicon-${t.kind === "view" ? "eye" : t.kind === "collection" ? "json" : t.kind === "keys" ? "key" : "table"}`}
                          aria-hidden="true"
                        />
                        <span className="db-row-name">{t.name}</span>
                        {typeof t.count === "number" && <span className="db-muted">{t.count}</span>}
                      </button>
                    ))
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function DatabasesPanel({ actionsTarget, showMenu }: { actionsTarget?: HTMLDivElement | null; showMenu?: (x: number, y: number, items: MenuItem[]) => void }) {
  const connections = useSyncExternalStore(subscribeConnections, getConnections);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshConnections().catch((err: Error) => setError(err.message));
  }, []);

  const actions = actionsTarget
    ? createPortal(
        <button className="icon-button" title="Add Connection" aria-label="Add connection" onClick={() => setAdding(true)}>
          <span className="codicon codicon-add" aria-hidden="true" />
        </button>,
        actionsTarget,
      )
    : null;

  return (
    <div className="db-panel">
      {actions}
      {adding && <AddForm onDone={() => setAdding(false)} />}
      {error && <div className="db-error db-pad">{error}</div>}
      {connections?.length === 0 && !adding && (
        <div className="db-muted db-pad">
          No connections yet.{" "}
          <button className="db-link" onClick={() => setAdding(true)}>
            Add one
          </button>
          , or right-click a .sqlite or .db file in FILES.
        </div>
      )}
      {connections?.map((c) => (
        <ConnectionNode key={c.id} conn={c} showMenu={showMenu} />
      ))}
    </div>
  );
}
