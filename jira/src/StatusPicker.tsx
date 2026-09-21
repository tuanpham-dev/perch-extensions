// Choosing a column's statuses: a search box over a checklist of every
// status, several at a time, without the list closing after each pick.
//
// Opens inline under its column in the column editor rather than as a second
// floating popover - a popover inside a popover fights the first one for
// position and scroll, and on a phone there is no room for both.
//
// A status already in this column stays in the list, ticked, so unticking is
// how it comes out. One held by another column stays visible but greyed out
// and can't be ticked here, with the column holding it named beside it - so
// the list still accounts for every status without letting one be pulled out
// of another column by accident. Moving it means unticking it there first.
// The ones still free to pick are listed first.
//
// Props only - the column editor owns the draft.
import { useState } from "react";
import type { BoardColumn } from "./boardModel";

export interface StatusPickerProps {
  column: BoardColumn;
  columns: BoardColumn[];
  statuses: { name: string; category: string | null }[];
  onToggle: (status: string, on: boolean) => void;
}

export default function StatusPicker({ column, columns, statuses, onToggle }: StatusPickerProps) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const owner = new Map<string, string>();
  for (const c of columns) for (const status of c.statuses) owner.set(status, c.name || "another column");
  const found = needle ? statuses.filter((s) => s.name.toLowerCase().includes(needle)) : statuses;
  const takenElsewhere = (name: string) => !column.statuses.includes(name) && owner.has(name);
  // Stable split: free (or already here) first, then those other columns
  // hold, each group keeping the category order it arrived in.
  const matches = [...found.filter((s) => !takenElsewhere(s.name)), ...found.filter((s) => takenElsewhere(s.name))];

  return (
    <div className="jira-statuspicker">
      <input
        className="jira-input"
        type="search"
        value={query}
        placeholder="Find a status"
        aria-label={`Find a status for ${column.name || "this column"}`}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="jira-statuspicker-list" role="group" aria-label="Statuses">
        {matches.length === 0 && <div className="jira-muted">No status matches.</div>}
        {matches.map((status) => {
          const here = column.statuses.includes(status.name);
          const elsewhere = !here ? owner.get(status.name) : undefined;
          return (
            <label
              key={status.name}
              className={`jira-statuspicker-row${elsewhere ? " taken" : ""}`}
              title={elsewhere ? `Already in ${elsewhere} - untick it there to move it here` : undefined}
            >
              <input
                type="checkbox"
                checked={here}
                disabled={Boolean(elsewhere)}
                onChange={(e) => onToggle(status.name, e.target.checked)}
              />
              <span className="jira-chip" data-cat={status.category ?? "unknown"}>
                {status.name}
              </span>
              {elsewhere && <span className="jira-statuspicker-owner">in {elsewhere}</span>}
            </label>
          );
        })}
      </div>
    </div>
  );
}
