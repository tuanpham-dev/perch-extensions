import { useMemo, useState } from "react";

// Rows from a query: a grid with each column's type under its name, NULL
// shown as NULL (not as an empty cell or the text "null"), a row-detail
// drawer, and CSV / JSON export of what's shown.

// MongoDB's Extended JSON wrappers read as their value in a cell.
const EJSON_SCALARS = ["$oid", "$date", "$numberLong", "$numberDecimal", "$numberDouble", "$numberInt"];

function display(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    if (keys.length === 1 && EJSON_SCALARS.includes(keys[0])) {
      const inner = (v as Record<string, unknown>)[keys[0]];
      return typeof inner === "object" ? JSON.stringify(inner) : String(inner);
    }
    return JSON.stringify(v);
  }
  return String(v);
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: { name: string }[], rows: unknown[][]): string {
  return [columns.map((c) => csvCell(c.name)).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n";
}

export function toJson(columns: { name: string }[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i] ?? null]))),
    null,
    2,
  );
}

export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ResultsGrid({ columns, rows }: { columns: { name: string; type: string }[]; rows: unknown[][] }) {
  const [detail, setDetail] = useState<number | null>(null);
  const widths = useMemo(
    () => columns.map((c, i) => Math.min(320, Math.max(60, c.name.length * 8, ...rows.slice(0, 50).map((r) => display(r[i]).length * 7)))),
    [columns, rows],
  );
  if (columns.length === 0) return null;
  return (
    <div className="db-grid-wrap">
      <div className="db-grid-scroll">
        <table className="db-grid">
          <thead>
            <tr>
              <th className="db-rownum">#</th>
              {columns.map((c, i) => (
                <th key={i} style={{ minWidth: widths[i] }}>
                  <span className="db-col-name">{c.name}</span>
                  {c.type && <span className="db-col-type">{c.type}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className={detail === ri ? "selected" : ""} onClick={() => setDetail(ri)}>
                <td className="db-rownum">{ri + 1}</td>
                {r.map((v, ci) => (
                  <td key={ci} className={v === null || v === undefined ? "db-null" : undefined} title={display(v).length > 60 ? display(v) : undefined}>
                    {display(v).length > 200 ? `${display(v).slice(0, 200)}…` : display(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail !== null && rows[detail] && (
        <div className="db-detail" role="dialog" aria-label={`Row ${detail + 1}`}>
          <div className="db-detail-head">
            <span>Row {detail + 1}</span>
            <button className="db-icon" title="Close" aria-label="Close row details" onClick={() => setDetail(null)}>
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          </div>
          <dl className="db-detail-list">
            {columns.map((c, i) => (
              <div key={i} className="db-detail-item">
                <dt>
                  {c.name} <span className="db-col-type">{c.type}</span>
                </dt>
                <dd className={rows[detail][i] === null ? "db-null" : undefined}>
                  {typeof rows[detail][i] === "object" && rows[detail][i] !== null ? (
                    <pre>{JSON.stringify(rows[detail][i], null, 2)}</pre>
                  ) : (
                    display(rows[detail][i])
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
