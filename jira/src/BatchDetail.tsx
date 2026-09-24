// What the batch knows about the ticket you have open: where it is, how it
// got there, what the agent said about it, and the box you write rework in.
//
// It sits under the ticket's own detail rather than replacing it, because
// reviewing means reading both - the ticket says what was asked for, this
// says what came back.
import { useEffect, useState } from "react";
import QaBlock from "./QaBlock";
import type { Batch, TicketStateName } from "./batchTypes";

export interface BatchDetailProps {
  batch: Batch;
  issueKey: string;
  busy: boolean;
  onFeedback: (key: string, text: string) => void;
  onAccept: (key: string) => void;
  onOpenTerminal: (clusterId: string) => void;
  onOpenShot: (key: string, which: "before" | "after", opener?: HTMLElement | null) => void;
  onOpenReport: (path: string) => void;
}

const STATE_LABEL: Record<TicketStateName, string> = {
  queued: "Queued",
  "in-progress": "In progress",
  "needs-you": "Needs you",
  review: "Review",
  rework: "Rework",
  done: "Done",
  failed: "Failed",
};

function when(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function BatchDetail({
  batch,
  issueKey,
  busy,
  onFeedback,
  onAccept,
  onOpenTerminal,
  onOpenShot,
  onOpenReport,
}: BatchDetailProps) {
  const ticket = batch.ticketStates[issueKey];
  const cluster = batch.clusters.find((entry) => entry.keys.includes(issueKey)) ?? null;
  const [draft, setDraft] = useState(ticket?.feedbackDraft ?? "");

  // Follow the server's copy when the ticket changes under us (another
  // browser, or the draft being cleared as it is sent), without fighting what
  // is being typed here.
  useEffect(() => {
    setDraft(batch.ticketStates[issueKey]?.feedbackDraft ?? "");
  }, [issueKey, batch.ticketStates[issueKey]?.feedbackDraft]);

  if (!cluster && !ticket) return null;

  const canReview = ticket && (ticket.state === "review" || ticket.state === "failed" || ticket.state === "rework");
  // Whether what is in the box is what the server holds. The draft saves on
  // blur, so this is the difference between "written" and "kept".
  const saved = Boolean(draft.trim()) && draft === (ticket?.feedbackDraft ?? "");

  return (
    <section className="jira-bdetail">
      <header className="jira-bdetail-head">
        <span className="jira-bdetail-title">Batch</span>
        {cluster && (
          <button
            className={`jira-bchip jira-bcol-c${cluster.color % 8} state-${cluster.state} static`}
            title={cluster.branch ? `Branch ${cluster.branch}` : cluster.name}
            disabled={busy || !cluster.sessionName}
            onClick={() => onOpenTerminal(cluster.id)}
          >
            <span className="jira-bchip-dot" />
            <span className="jira-bchip-name">{cluster.name}</span>
          </button>
        )}
        {ticket && <span className={`jira-bstate jira-bstate-${ticket.state}`}>{STATE_LABEL[ticket.state]}</span>}
      </header>

      {!ticket && <p className="jira-bdetail-note">In this batch, but its cluster has not started yet.</p>}

      {ticket && (
        <>
          {ticket.qa ? (
            <QaBlock
              report={ticket.qa}
              history={ticket.qaHistory ?? []}
              issueKey={issueKey}
              batchId={batch.id}
              onOpenShot={(which, opener) => onOpenShot(issueKey, which, opener)}
              onOpenReport={onOpenReport}
            />
          ) : (
            (ticket.state === "review" || ticket.state === "failed") && (
              <p className="jira-qa-missing">
                No QA report was filed for this ticket. The agent finished it without one - what it did is in its
                summary, but nothing was checked or captured.
              </p>
            )
          )}

          {/* A timeline of where it has been. The note on the last entry is
              the same text as the summary shown right below it, so it is left
              out rather than printed twice in two different truncations. */}
          <ol className="jira-bhistory">
            {ticket.history.map((entry, i) => {
              const note = entry.note && entry.note !== ticket.summary && entry.note !== ticket.reason ? entry.note : "";
              return (
                <li key={`${entry.at}-${i}`}>
                  <span className="jira-bhistory-at">{when(entry.at)}</span>
                  <span className="jira-bhistory-state">{STATE_LABEL[entry.state]}</span>
                  {/* Always three cells: the rows are grid columns, and an
                      entry that contributed two pulled every later row out of
                      alignment. */}
                  <span className="jira-bhistory-note">{note}</span>
                </li>
              );
            })}
          </ol>

          {ticket.summary && (
            <p className="jira-bdetail-said">
              <b>The agent says:</b> {ticket.summary}
            </p>
          )}
          {ticket.reason && (
            <p className="jira-bdetail-said failed">
              <b>Could not finish:</b> {ticket.reason}
            </p>
          )}

          {ticket.feedback.length > 0 && (
            <ul className="jira-bfeedback">
              {ticket.feedback.map((entry, i) => (
                <li key={`${entry.sentAt}-${i}`}>
                  <span className="jira-bfeedback-at">sent {when(entry.sentAt)}</span>
                  <span className="jira-bfeedback-text">{entry.text}</span>
                </li>
              ))}
            </ul>
          )}

          {canReview && (
            <>
              <label className="jira-field-label" htmlFor={`jira-feedback-${issueKey}`}>
                Feedback
              </label>
              <textarea
                id={`jira-feedback-${issueKey}`}
                className="jira-batchform-criteria"
                rows={3}
                value={draft}
                disabled={busy}
                placeholder="What needs changing? It goes to this cluster's agent when you press Send feedback."
                onChange={(e) => setDraft(e.target.value)}
                // Saved on blur rather than per keystroke: the draft lives on
                // the server so it survives a reload, and a POST per character
                // would be a write storm for no gain.
                onBlur={() => {
                  if (draft !== (ticket.feedbackDraft ?? "")) onFeedback(issueKey, draft);
                }}
              />
              <div className="jira-bdetail-actions">
                <span className="jira-bdetail-hint">
                  {/* What is actually true right now. The draft is saved on
                      blur, so saying "saved" while it is still only in this
                      box would be a promise the server has not made. */}
                  {saved
                    ? "Saved as a draft - send it from the board."
                    : draft.trim()
                      ? "Not saved yet - click outside the box."
                      : "Nothing to send yet."}
                </span>
                {(ticket.state === "review" || ticket.state === "failed") && (
                  <button className="jira-selaction primary" disabled={busy} onClick={() => onAccept(issueKey)}>
                    Accept
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
