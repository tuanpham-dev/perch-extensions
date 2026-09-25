// What the batch knows about the ticket you have open: where it is, how it
// got there, what the agent said about it, and the box you write rework in.
//
// It sits under the ticket's own detail rather than replacing it, because
// reviewing means reading both - the ticket says what was asked for, this
// says what came back.
import { useEffect, useState } from "react";
import QaBlock from "./QaBlock";
import KeyLink from "./KeyLink";
import type { Batch, TicketStateName, BatchQa, IntegrationState, TicketState } from "./batchTypes";

export interface BatchDetailProps {
  batch: Batch;
  issueKey: string;
  busy: boolean;
  onFeedback: (key: string, text: string) => void;
  onAccept: (key: string) => void;
  // The QA branch's verdicts. Only offered while a QA agent is running.
  onMergeTicket: (key: string) => void;
  onRequestChange: (key: string, change: string) => void;
  onApproveQa: (key: string, notes: { note: string; refinedNote: string; postedNote: string }) => void;
  onExcludeQa: (key: string, why: string) => void;
  onRefineNote: (key: string, note: string) => Promise<{ refined: string; asWritten: boolean }>;
  onOpenTerminal: (clusterId: string) => void;
  // "before", "after", or "shot-<n>" for one of the extras.
  onOpenShot: (key: string, which: string, opener?: HTMLElement | null) => void;
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
  onMergeTicket,
  onRequestChange,
  onApproveQa,
  onExcludeQa,
  onRefineNote,
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
  // While a ticket is on the QA branch its verdicts come from the QA block
  // below, and the cluster feedback box is hidden: feedback there would send
  // the ticket back to its cluster agent, which is the wrong agent now.
  const qaRunning = batch.qa?.state === "running";
  const integration = ticket?.integration?.state ?? "none";
  const onQaBranch = qaRunning && ["merging", "merged", "fixing"].includes(integration);
  // Whether what is in the box is what the server holds. The draft saves on
  // blur, so this is the difference between "written" and "kept".
  const saved = Boolean(draft.trim()) && draft === (ticket?.feedbackDraft ?? "");

  return (
    <section className="jira-bdetail">
      <header className="jira-bdetail-head">
        <span className="jira-bdetail-title">Batch</span>
        <KeyLink issueKey={issueKey} url={batch.tickets[issueKey]?.url} />
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
          {qaRunning && batch.qa && (
            <QaVerdicts
              batchQa={batch.qa}
              ticket={ticket}
              issueKey={issueKey}
              busy={busy}
              onMerge={() => onMergeTicket(issueKey)}
              onChange={(text) => onRequestChange(issueKey, text)}
              onApprove={(notes) => onApproveQa(issueKey, notes)}
              onExclude={(why) => onExcludeQa(issueKey, why)}
              onRefine={(note) => onRefineNote(issueKey, note)}
            />
          )}
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

          {canReview && !onQaBranch && (
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


// ---- The QA branch's verdicts ----
//
// What the reviewer decides about a ticket that is on the QA branch. Three
// verdicts, each with the one thing it needs: a change wants the words, an
// exclusion wants a reason, an approval may carry a note - which is refined
// and shown before anything is posted, because it goes out under the
// reviewer's name.

type VerdictMode = "idle" | "change" | "approve" | "exclude";

const INTEGRATION_LABEL: Record<IntegrationState, string> = {
  none: "not merged",
  merging: "merging",
  merged: "verifying",
  fixing: "fix uncommitted",
  approved: "approved",
  excluded: "excluded",
  conflicted: "conflicted",
};

function QaVerdicts({
  batchQa,
  ticket,
  issueKey,
  busy,
  onMerge,
  onChange,
  onApprove,
  onExclude,
  onRefine,
}: {
  batchQa: BatchQa;
  ticket: TicketState;
  issueKey: string;
  busy: boolean;
  onMerge: () => void;
  onChange: (text: string) => void;
  onApprove: (notes: { note: string; refinedNote: string; postedNote: string }) => void;
  onExclude: (why: string) => void;
  onRefine: (note: string) => Promise<{ refined: string; asWritten: boolean }>;
}) {
  const integration = ticket.integration;
  const state = integration?.state ?? "none";
  const [mode, setMode] = useState<VerdictMode>("idle");
  const [text, setText] = useState("");
  // The note's three forms while approving: typed, refined, and the one that
  // will be posted - which starts as the refined one and becomes whatever the
  // reviewer edits it into, or their own words if they say so.
  const [refined, setRefined] = useState<{ text: string; asWritten: boolean } | null>(null);
  const [posted, setPosted] = useState("");
  const [refining, setRefining] = useState(false);

  useEffect(() => {
    // A different ticket, or a state change under us, drops any half-typed
    // verdict: it belonged to the previous situation.
    setMode("idle");
    setText("");
    setRefined(null);
    setPosted("");
  }, [issueKey, state]);

  const reset = () => {
    setMode("idle");
    setText("");
    setRefined(null);
    setPosted("");
  };

  const refine = async () => {
    const note = text.trim();
    if (!note) {
      onApprove({ note: "", refinedNote: "", postedNote: "" });
      reset();
      return;
    }
    setRefining(true);
    try {
      const out = await onRefine(note);
      setRefined({ text: out.refined, asWritten: out.asWritten });
      setPosted(out.refined);
    } finally {
      setRefining(false);
    }
  };

  const approveWith = (postedNote: string) => {
    onApprove({ note: text.trim(), refinedNote: refined?.asWritten ? "" : (refined?.text ?? ""), postedNote });
    reset();
  };

  if (ticket.state !== "review" && state === "none") return null;

  return (
    <section className={`jira-qav qa-${state}`}>
      <header className="jira-qav-head">
        <span className="jira-bdetail-title">QA branch</span>
        <span className={`jira-qav-state is-${state}`}>{INTEGRATION_LABEL[state]}</span>
        {integration?.commit && <span className="jira-qav-commit mono" title="Its commit on the QA branch">{integration.commit.slice(0, 7)}</span>}
        {batchQa.previewUrl && (state === "merged" || state === "fixing") && (
          <a className="jira-linkish" href={batchQa.previewUrl} target="_blank" rel="noreferrer" title="The dev server, serving the QA branch">
            Open the page
          </a>
        )}
      </header>

      {state === "none" && ticket.state === "review" && mode === "idle" && (
        <div className="jira-qav-row">
          <span className="jira-qav-hint">Reviewed and not yet on {batchQa.branch}.</span>
          <button className="jira-selaction primary" disabled={busy || batchQa.state !== "running"} onClick={onMerge} title={`Cherry-pick ${issueKey} onto ${batchQa.branch} and serve it`}>
            Merge into QA
          </button>
          <span className="jira-qav-spacer" />
          <button className="jira-selaction" disabled={busy} onClick={() => setMode("exclude")} title="Leave it out of this run - nothing to drop, it was never merged">
            Exclude
          </button>
        </div>
      )}

      {state === "merging" && <p className="jira-qav-hint">The QA agent is cherry-picking it and restarting the server.</p>}

      {state === "fixing" && integration?.change && (
        <div className="jira-qav-field">
          <b>You asked for</b>
          <pre className="jira-qav-change">{integration.change}</pre>
          {integration.fixed && (
            <>
              <b>Changed</b>
              <pre className="jira-qav-change">{integration.fixed}</pre>
            </>
          )}
          <span className="jira-qav-hint">Made in the QA worktree, not committed. Approving amends it into {issueKey}'s commit.</span>
        </div>
      )}

      {state === "conflicted" && (
        <div className="jira-qav-field">
          <b>Would not apply</b>
          {integration?.files.length ? <span className="mono">{integration.files.join(", ")}</span> : null}
          {integration?.why && <span className="jira-qav-hint">{integration.why}</span>}
          <span className="jira-qav-hint">Its cluster's agent has been told. Merge again once it has been sorted out.</span>
          <div className="jira-qav-row">
            <button className="jira-selaction" disabled={busy} onClick={onMerge}>
              Merge again
            </button>
          </div>
        </div>
      )}

      {state === "excluded" && (
        <div className="jira-qav-field">
          <b>Excluded</b>
          <span className="jira-qav-hint">{integration?.why || "no reason given"}</span>
          <div className="jira-qav-row">
            <button className="jira-selaction" disabled={busy || ticket.state !== "review"} onClick={onMerge} title="Put it back in the queue">
              Merge after all
            </button>
          </div>
        </div>
      )}

      {state === "approved" && (
        <div className="jira-qav-field">
          <b>Approved</b>
          {integration?.postedNote ? <span className="jira-qav-note">{integration.postedNote}</span> : <span className="jira-qav-hint">No note.</span>}
          {integration?.handoff && (
            <span className={`jira-qav-hint ${integration.handoff.ok ? "" : "jira-error"}`}>
              {integration.handoff.ok ? "Handed off to Jira." : `Hand-off failed: ${integration.handoff.error}`}
            </span>
          )}
        </div>
      )}

      {(state === "merged" || state === "fixing") && mode === "idle" && (
        <div className="jira-qav-row">
          <button className="jira-selaction primary" disabled={busy} onClick={() => setMode("approve")} title="Keep it, mark the ticket done">
            Approve
          </button>
          <button className="jira-selaction" disabled={busy} onClick={() => setMode("change")} title="Ask the QA agent to change something, without committing">
            {state === "fixing" ? "Request another change" : "Request a change"}
          </button>
          <span className="jira-qav-spacer" />
          <button className="jira-selaction" disabled={busy} onClick={() => setMode("exclude")} title="Leave it out of this run">
            Exclude
          </button>
        </div>
      )}

      {mode === "change" && (
        <div className="jira-qav-form">
          <textarea
            className="jira-bfeedback-box"
            rows={3}
            value={text}
            placeholder="What should be different? e.g. do not resize the image on hover"
            autoFocus
            onChange={(e) => setText(e.target.value)}
          />
          <div className="jira-qav-row">
            <button className="jira-selaction primary" disabled={busy || !text.trim()} onClick={() => { onChange(text.trim()); reset(); }}>
              Send to the QA agent
            </button>
            <button className="jira-selaction" disabled={busy} onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "exclude" && (
        <div className="jira-qav-form">
          <input
            className="jira-bfeedback-box"
            value={text}
            placeholder="Why? e.g. assigned to someone else"
            autoFocus
            onChange={(e) => setText(e.target.value)}
          />
          <div className="jira-qav-row">
            <button className="jira-selaction primary" disabled={busy} onClick={() => { onExclude(text.trim()); reset(); }}>
              Exclude {issueKey}
            </button>
            <button className="jira-selaction" disabled={busy} onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "approve" && !refined && (
        <div className="jira-qav-form">
          <label className="jira-qav-label">
            Note (optional) - an observation, not a change request
            <textarea
              className="jira-bfeedback-box"
              rows={2}
              value={text}
              placeholder="e.g. image is different than in figma (maybe client did it)"
              autoFocus
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <div className="jira-qav-row">
            <button className="jira-selaction primary" disabled={busy || refining} onClick={() => void refine()}>
              {refining ? "Refining the note..." : text.trim() ? "Continue" : "Approve"}
            </button>
            <button className="jira-selaction" disabled={busy || refining} onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "approve" && refined && (
        <div className="jira-qav-form">
          <div className="jira-qav-field">
            <b>Your note</b>
            <span className="jira-qav-note">{text.trim()}</span>
          </div>
          <label className="jira-qav-label">
            {refined.asWritten ? "Will be posted as written (it could not be restated without guessing)" : `Will be posted to ${issueKey}`}
            <textarea className="jira-bfeedback-box refined" rows={3} value={posted} onChange={(e) => setPosted(e.target.value)} />
          </label>
          <div className="jira-qav-row">
            <button className="jira-selaction primary" disabled={busy || !posted.trim()} onClick={() => approveWith(posted.trim())}>
              Approve
            </button>
            {!refined.asWritten && posted !== text.trim() && (
              <button className="jira-selaction" disabled={busy} onClick={() => setPosted(text.trim())} title="Post exactly what you typed">
                Post mine as written
              </button>
            )}
            <button className="jira-selaction" disabled={busy} onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
