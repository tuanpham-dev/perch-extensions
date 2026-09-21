// Setting up the board's columns, on the board itself: rename, reorder,
// remove, add, and choose which statuses each column holds.
//
// Edits a local draft, so Cancel really discards and nothing reaches the
// synced setting until Save. A status can sit in one column only - giving it
// to a column takes it from any other (boardModel.assignStatus) - and the
// footer lists the statuses no column claims, since those are exactly the
// ones that will get columns of their own on the board.
//
// Props only - client.tsx imports this file.
import { useEffect, useState } from "react";
import Icon from "./Icon";
import StatusPicker from "./StatusPicker";
import { usePopoverPosition, type PopoverAnchor } from "./usePopoverPosition";
import {
  COLUMN_COLORS,
  addColumn,
  assignStatus,
  setColumnColor,
  setHideUnassigned,
  moveColumn,
  removeColumn,
  renameColumn,
  unassignStatus,
  unassignedStatuses,
  validateBoard,
  type BoardConfig,
} from "./boardModel";

export interface ColumnEditorProps {
  anchor: PopoverAnchor;
  config: BoardConfig;
  // Every status worth offering, in category order, with its category.
  statuses: { name: string; category: string | null }[];
  onSave: (config: BoardConfig) => void;
  onCancel: () => void;
}

export default function ColumnEditor({ anchor, config, statuses, onSave, onCancel }: ColumnEditorProps) {
  const [draft, setDraft] = useState<BoardConfig>(config);
  const [error, setError] = useState<string | null>(null);
  // The column whose status picker is open; one at a time keeps the list
  // short enough to read on a phone.
  const [picking, setPicking] = useState<string | null>(null);
  const { ref, style } = usePopoverPosition<HTMLDivElement>(anchor, [draft.columns.length, error]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Every edit is applied to the latest draft, never to the one this render
  // saw. Ticking several statuses in quick succession - which the picker
  // exists for - fires changes faster than the editor re-renders, and edits
  // built from a stale draft each overwrote the one before, so all but the
  // last tick were lost.
  const edit = (change: (draft: BoardConfig) => BoardConfig) => {
    setDraft((current) => change(current));
    setError(null);
  };

  const save = () => {
    const unnamed = validateBoard(draft);
    if (unnamed !== null) {
      setError(`Column ${unnamed + 1} needs a name.`);
      return;
    }
    onSave(draft);
  };

  const free = unassignedStatuses(
    draft,
    statuses.map((status) => status.name),
  );

  return (
    <div ref={ref} className="jira-popover jira-columneditor" role="dialog" aria-label="Edit columns" style={style}>
      {/* Save sits in the header, which stays pinned while the columns scroll
          under it - at the foot of a long list it was out of sight. Close
          discards, as Cancel did. */}
      <div className="jira-pop-head jira-columneditor-head">
        <span className="jira-facets-title">Edit columns</span>
        <button className="jira-selaction primary" onClick={save}>
          Save
        </button>
        <button className="icon-button" title="Close without saving" onClick={onCancel}>
          <Icon name="close" />
        </button>
      </div>
      {error && <div className="jira-error">{error}</div>}

      {draft.columns.length === 0 && (
        <div className="jira-muted">No columns yet - every status is its own column until you add some.</div>
      )}

      <ol className="jira-columnlist">
        {draft.columns.map((column, i) => (
          <li key={column.id} className="jira-columnrow">
            <div className="jira-columnrow-head">
              <button
                className="icon-button"
                title="Move up (earlier on the board)"
                disabled={i === 0}
                onClick={() => edit((d) => moveColumn(d, column.id, -1))}
              >
                <Icon name="arrow-up" />
              </button>
              <button
                className="icon-button"
                title="Move down (later on the board)"
                disabled={i === draft.columns.length - 1}
                onClick={() => edit((d) => moveColumn(d, column.id, 1))}
              >
                <Icon name="arrow-down" />
              </button>
              <input
                className="jira-input"
                value={column.name}
                placeholder="Column name"
                aria-label={`Name of column ${i + 1}`}
                onChange={(e) => {
                  const name = e.target.value;
                  edit((d) => renameColumn(d, column.id, name));
                }}
              />
              <button
                className="icon-button"
                title="Remove this column"
                onClick={() => edit((d) => removeColumn(d, column.id))}
              >
                <Icon name="trash" />
              </button>
            </div>
            <div className="jira-swatches" role="radiogroup" aria-label={`Colour of ${column.name || `column ${i + 1}`}`}>
              <button
                role="radio"
                aria-checked={!column.color}
                className={`jira-swatch none${!column.color ? " current" : ""}`}
                title="No colour"
                onClick={() => edit((d) => setColumnColor(d, column.id, null))}
              />
              {COLUMN_COLORS.map((color) => (
                <button
                  key={color}
                  role="radio"
                  aria-checked={column.color === color}
                  className={`jira-swatch${column.color === color ? " current" : ""}`}
                  data-color={color}
                  title={color[0].toUpperCase() + color.slice(1)}
                  onClick={() => edit((d) => setColumnColor(d, column.id, color))}
                />
              ))}
            </div>
            <div className="jira-columnrow-statuses">
              {column.statuses.map((status) => (
                <button
                  key={status}
                  className="jira-filter-chip"
                  title={`Take ${status} out of this column`}
                  onClick={() => edit((d) => unassignStatus(d, status))}
                >
                  {status}
                  <span aria-hidden="true">&times;</span>
                </button>
              ))}
              <button
                className="jira-selaction jira-addstatus"
                aria-expanded={picking === column.id}
                onClick={() => setPicking(picking === column.id ? null : column.id)}
              >
                <Icon name={picking === column.id ? "chevron-up" : "add"} /> Statuses
              </button>
            </div>
            {picking === column.id && (
              <StatusPicker
                column={column}
                columns={draft.columns}
                statuses={statuses}
                onToggle={(status, on) =>
                  edit((d) => (on ? assignStatus(d, status, column.id) : unassignStatus(d, status)))
                }
              />
            )}
          </li>
        ))}
      </ol>

      <button className="jira-selaction" onClick={() => edit((d) => addColumn(d, "New column"))}>
        <Icon name="add" /> Add column
      </button>

      <label className="jira-hideunassigned">
        <input
          type="checkbox"
          checked={draft.hideUnassigned === true}
          disabled={draft.columns.length === 0}
          onChange={(e) => {
            const hide = e.target.checked;
            edit((d) => setHideUnassigned(d, hide));
          }}
        />
        <span>
          Hide statuses that aren't in any column
          {draft.columns.length === 0 && " (add a column first)"}
        </span>
      </label>

      {free.length > 0 && (
        <p className="jira-settings-hint">
          Not in any column: {free.join(", ")}.{" "}
          {draft.hideUnassigned && draft.columns.length > 0
            ? "Their tickets are left off the board."
            : "Each gets a column of its own after yours, while a ticket has it."}
        </p>
      )}
    </div>
  );
}
