// After the production merge: which approved tickets have been handed to
// Jira, which failed and why. One row per ticket, so a half-finished run is
// legible and the bar's "Hand off" button - which only sends the ones still
// owed - reads as the retry it is.
import KeyLink from "./KeyLink";
import type { Batch } from "./batchTypes";

export default function HandoffPanel({ batch }: { batch: Batch }) {
  const rows = Object.keys(batch.ticketStates)
    .filter((key) => batch.ticketStates[key].integration?.state === "approved")
    .map((key) => ({ key, handoff: batch.ticketStates[key].integration?.handoff ?? null, summary: batch.tickets[key]?.summary ?? "" }));
  if (rows.length === 0) return null;
  const done = rows.filter((row) => row.handoff?.ok).length;
  const failed = rows.filter((row) => row.handoff && !row.handoff.ok).length;
  return (
    <section className="jira-handoff" aria-label="Hand-off to Jira">
      <header className="jira-handoff-head">
        <span className="jira-bdetail-title">Hand-off</span>
        <span className="jira-qav-hint">
          {done} of {rows.length} handed off{failed > 0 ? `, ${failed} failed` : ""}
        </span>
      </header>
      <ul className="jira-handoff-rows">
        {rows.map((row) => (
          <li key={row.key} className={row.handoff ? (row.handoff.ok ? "ok" : "failed") : "pending"}>
            <KeyLink issueKey={row.key} url={batch.tickets[row.key]?.url} />
            <span className="jira-handoff-mark">{row.handoff ? (row.handoff.ok ? "✓" : "✗") : "·"}</span>
            <span className="jira-handoff-text">
              {row.handoff ? (row.handoff.ok ? "moved to QA, assigned, commented" : row.handoff.error) : "not yet"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
