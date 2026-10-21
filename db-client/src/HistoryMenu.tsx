import { useEffect, useRef, useState } from "react";
import { call, host } from "./host";

export interface HistoryEntry {
  at: number;
  text: string;
}

// The History button and its menu: a connection's past queries, newest
// first, with a search box and Clear. `describe` turns a stored entry into
// the line shown (a MongoDB query is stored as its JSON spec).
export function HistoryMenu({
  connId,
  connName,
  onPick,
  describe = (text) => text,
}: {
  connId: string;
  connName: string;
  onPick: (text: string) => void;
  describe?: (text: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // Reloads on open and as the search changes; a slower earlier answer
  // can't replace a newer one.
  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    call<{ entries: HistoryEntry[] }>(`/history?id=${encodeURIComponent(connId)}&q=${encodeURIComponent(search)}`)
      .then((d) => {
        if (mine !== seq.current) return;
        setEntries(d.entries);
        setError(null);
      })
      .catch((err: Error) => {
        if (mine === seq.current) setError(err.message);
      });
  }, [open, search, connId]);

  const clear = async () => {
    const ok = (await host.app?.confirmDialog?.(`Clear the query history of "${connName}"?`, "Clear History")) ?? true;
    if (!ok) return;
    try {
      await call(`/history?id=${encodeURIComponent(connId)}`, { method: "DELETE" });
      setEntries([]);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="db-history-wrap">
      <button className="db-button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        History
      </button>
      {open && (
        <div className="db-history" role="menu">
          <div className="db-history-bar">
            <input
              className="db-input"
              autoFocus
              placeholder="Search history"
              aria-label="Search history"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setOpen(false);
              }}
            />
            <button className="db-link" onClick={() => void clear()} disabled={!entries?.length || Boolean(search)} title={search ? "Clear the search to clear the history" : undefined}>
              Clear
            </button>
          </div>
          {error && <div className="db-error db-pad">{error}</div>}
          {entries?.length === 0 && <div className="db-muted db-pad">{search ? "No queries match." : "No queries yet."}</div>}
          {entries?.map((h) => (
            <button
              key={h.at}
              role="menuitem"
              className="db-history-row"
              onClick={() => {
                onPick(h.text);
                setOpen(false);
              }}
            >
              <span className="db-history-text">{describe(h.text)}</span>
              <span className="db-muted">{new Date(h.at).toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
