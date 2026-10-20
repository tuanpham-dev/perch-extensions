import { useState } from "react";

// A collapsible JSON tree for response bodies. Objects and arrays past the
// first two levels start closed, so a large payload opens readable.
function Value({ value, name, depth }: { value: unknown; name?: string; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const label = name !== undefined ? <span className="hc-json-key">{JSON.stringify(name)}: </span> : null;
  if (value === null || typeof value !== "object") {
    const kind = value === null ? "null" : typeof value;
    return (
      <div className="hc-json-row">
        {label}
        <span className={`hc-json-${kind}`}>{JSON.stringify(value)}</span>
      </div>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const [openMark, closeMark] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  const summary = Array.isArray(value) ? `${entries.length} items` : `${entries.length} keys`;
  return (
    <div className="hc-json-node">
      <button className="hc-json-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={`codicon codicon-chevron-${open ? "down" : "right"}`} aria-hidden="true" />
        {label}
        {openMark}
        {!open && <span className="hc-json-summary"> {summary} </span>}
        {!open && closeMark}
      </button>
      {open && (
        <div className="hc-json-children">
          {entries.map(([k, v]) => (
            <Value key={k} name={Array.isArray(value) ? undefined : k} value={v} depth={depth + 1} />
          ))}
          <div className="hc-json-row">{closeMark}</div>
        </div>
      )}
    </div>
  );
}

export function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="hc-json">
      <Value value={value} depth={0} />
    </div>
  );
}
