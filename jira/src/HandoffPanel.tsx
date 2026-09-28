// After the production merge: where the approved tickets go in Jira, and
// which have been handed off, which failed and why.
//
// The three answers the hand-off needs - the status the tickets move to, who
// they are assigned to, and the preview URL the comment points at - are this
// batch's own, set here. A field left empty takes what Settings says, which
// the field shows as its placeholder, so a batch nobody touched behaves as
// before. Saved on the batch as each field is left, so the bar's "Hand off"
// button, and a retry of the ones that failed, use what is on screen.
//
// One row per ticket below, so a half-finished run is legible and the bar's
// "Hand off" button - which only sends the ones still owed - reads as the
// retry it is.
import { useEffect, useState } from "react";
import Icon from "./Icon";
import KeyLink from "./KeyLink";
import { getHandoffConfig, getHandoffPreview } from "./batchApi";
import type { Batch, HandoffConfig } from "./batchTypes";
import { isShippedTicket } from "./batchViewModel";
import type { Facets } from "./types";
import { useStickyState } from "./stickyState";

type Field = keyof HandoffConfig;

const FIELDS: { field: Field; label: string; empty: string; hint: string }[] = [
  { field: "status", label: "Status", empty: "QA", hint: "The Jira status the tickets move to, matched by name" },
  { field: "assignee", label: "Assignee", empty: "unchanged", hint: "A display name, an email or an account id. Empty everywhere leaves the assignee alone" },
  {
    field: "previewUrl",
    label: "Preview",
    empty: "no link",
    hint: "The preview theme the comment points at. {key} becomes the ticket key",
  },
];

export interface HandoffPanelProps {
  batch: Batch;
  busy: boolean;
  facets: Facets | null;
  onSave: (config: Partial<HandoffConfig>) => void;
}

function doneText(handoff: { status?: string; assignee?: string }): string {
  const parts = [handoff.status ? `moved to ${handoff.status}` : "moved"];
  if (handoff.assignee) parts.push(`assigned to ${handoff.assignee}`);
  parts.push("commented");
  return parts.join(", ");
}

export default function HandoffPanel({ batch, busy, facets, onSave }: HandoffPanelProps) {
  const saved: HandoffConfig = batch.handoffConfig ?? { status: "", assignee: "", previewUrl: "" };
  const [defaults, setDefaults] = useState<HandoffConfig | null>(null);
  // The comment each ticket will get, read before it goes out under your
  // name. Refetched when the batch changes, since the note and the preview
  // URL feed it.
  const [preview, setPreview] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getHandoffPreview(batch.id)
      .then((res) => {
        if (!cancelled) setPreview(Object.fromEntries(res.tickets.map((ticket) => [ticket.key, ticket.comment])));
      })
      .catch(() => {
        // No preview is not a reason to block the hand-off itself.
      });
    return () => {
      cancelled = true;
    };
  }, [batch.id, batch.updatedAt]);
  // What is being typed, per field, until it is saved on blur. Kept outside
  // the component so leaving the tab mid-edit loses nothing.
  const [edits, setEdits] = useStickyState<Partial<HandoffConfig>>(`handoff:${batch.id}`, {});

  // Edits the server now holds are no longer edits.
  useEffect(() => {
    const settled = (Object.keys(edits) as Field[]).filter((field) => (edits[field] ?? "").trim() === saved[field]);
    if (settled.length === 0) return;
    const rest = { ...edits };
    for (const field of settled) delete rest[field];
    setEdits(rest);
  }, [saved.status, saved.assignee, saved.previewUrl]);

  useEffect(() => {
    let cancelled = false;
    getHandoffConfig(batch.id)
      .then((res) => {
        if (!cancelled) setDefaults(res.defaults);
      })
      .catch(() => {
        // Without them the placeholders just say less.
      });
    return () => {
      cancelled = true;
    };
  }, [batch.id]);

  const rows = Object.keys(batch.ticketStates)
    // Only what has reached production: a ticket approved in a round that
    // has not shipped yet is not ready to hand off.
    .filter((key) => batch.ticketStates[key].integration?.state === "approved" && isShippedTicket(batch, key))
    .map((key) => ({ key, handoff: batch.ticketStates[key].integration?.handoff ?? null, summary: batch.tickets[key]?.summary ?? "" }));
  if (rows.length === 0) return null;
  const done = rows.filter((row) => row.handoff?.ok).length;
  const failed = rows.filter((row) => row.handoff && !row.handoff.ok).length;

  const valueOf = (field: Field) => edits[field] ?? saved[field];
  // Saved when the field is left, but the edit is kept until the batch comes
  // back with it: a click on Hand off right after typing reads the edits,
  // and must not find them already gone while the save is in flight.
  const commit = (field: Field) => {
    const value = edits[field];
    if (value === undefined) return;
    if (value.trim() !== saved[field]) onSave({ [field]: value.trim() });
  };

  const suggestions: Partial<Record<Field, string[]>> = {
    status: facets?.statuses.map((s) => s.name) ?? [],
    assignee: facets?.assignees.map((u) => u.displayName) ?? [],
  };

  return (
    <section className="jira-handoff" aria-label="Hand-off to Jira">
      <header className="jira-handoff-head">
        <span className="jira-bdetail-title">Hand-off</span>
        <span className="jira-qav-hint">
          {done} of {rows.length} handed off{failed > 0 ? `, ${failed} failed` : ""}
        </span>
      </header>

      <div className="jira-handoff-config">
        {FIELDS.map(({ field, label, empty, hint }) => {
          const fallback = defaults?.[field] || empty;
          const listId = suggestions[field]?.length ? `jira-handoff-${batch.id}-${field}` : undefined;
          return (
            <label key={field} className="jira-handoff-field" title={hint}>
              <span className="jira-handoff-label">{label}</span>
              <input
                className="jira-input"
                value={valueOf(field)}
                placeholder={`From Settings: ${fallback}`}
                list={listId}
                disabled={busy}
                spellCheck={false}
                onChange={(e) => setEdits({ ...edits, [field]: e.target.value })}
                onBlur={() => commit(field)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
              {listId && (
                <datalist id={listId}>
                  {[...new Set(suggestions[field])].map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              )}
            </label>
          );
        })}
      </div>

      <ul className="jira-handoff-rows">
        {rows.map((row) => (
          <li key={row.key} className={row.handoff ? (row.handoff.ok ? "ok" : "failed") : "pending"}>
            <KeyLink issueKey={row.key} url={batch.tickets[row.key]?.url} />
            <span className="jira-handoff-mark">
              <Icon name={row.handoff ? (row.handoff.ok ? "check" : "close") : "circle-small"} />
            </span>
            <span className="jira-handoff-text">
              {row.handoff ? (row.handoff.ok ? doneText(row.handoff) : row.handoff.error) : "not yet"}
            </span>
            {preview[row.key] && (
              <button
                className="jira-linkish"
                aria-expanded={open === row.key}
                title="The comment this ticket gets in Jira"
                onClick={() => setOpen(open === row.key ? null : row.key)}
              >
                {open === row.key ? "Hide comment" : "Comment"}
              </button>
            )}
            {open === row.key && preview[row.key] && <pre className="jira-handoff-preview">{preview[row.key]}</pre>}
          </li>
        ))}
      </ul>
    </section>
  );
}
