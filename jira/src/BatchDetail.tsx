// What the batch knows about the ticket you have open: where it is, how it
// got there, what the agent said about it, and the box you write rework in.
//
// It sits under the ticket's own detail rather than replacing it, because
// reviewing means reading both - the ticket says what was asked for, this
// says what came back.
import { useEffect } from "react";
import { clearSticky, useStickyState } from "./stickyState";
import QaBlock from "./QaBlock";
import QaDiff from "./QaDiff";
import AgentTerminal from "./AgentTerminal";
import type { AgentTarget } from "./AgentTerminal";
import KeyLink from "./KeyLink";
import type { Batch, TicketStateName, BatchQa, IntegrationState, TicketState } from "./batchTypes";

export interface BatchDetailProps {
  batch: Batch;
  issueKey: string;
  busy: boolean;
  onFeedback: (key: string, text: string) => void;
  onAccept: (key: string) => void;
  // Takes a done ticket back to review - an accept or a QA approval undone.
  onReopen: (key: string) => void;
  // The QA branch's verdicts. Only offered while a QA agent is running.
  onMergeTicket: (key: string) => void;
  onRequestChange: (key: string, change: string) => void;
  onApproveQa: (key: string, notes: { note: string; refinedNote: string; postedNote: string }) => void;
  onExcludeQa: (key: string, why: string) => void;
  onRefineNote: (key: string, note: string) => void;
  onClearRefine: (key: string) => void;
  onOpenTerminal: (clusterId: string) => void;
  onOpenQaTerminal: () => void;
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
  onReopen,
  onMergeTicket,
  onRequestChange,
  onApproveQa,
  onExcludeQa,
  onRefineNote,
  onClearRefine,
  onOpenTerminal,
  onOpenQaTerminal,
  onOpenShot,
  onOpenReport,
}: BatchDetailProps) {
  const ticket = batch.ticketStates[issueKey];
  const cluster = batch.clusters.find((entry) => entry.keys.includes(issueKey)) ?? null;
  // What is typed in the feedback box, kept outside the component so it
  // survives the pane unmounting before the blur that saves it. Tied to the
  // server's copy it was typed over: when that changes (another browser, or
  // the draft being cleared as it is sent) the server's wins.
  const serverDraft = ticket?.feedbackDraft ?? "";
  const [edit, setEdit] = useStickyState<{ text: string; base: string } | null>(`fb:${batch.id}:${issueKey}`, null);
  const draft = edit && edit.base === serverDraft ? edit.text : serverDraft;
  const setDraft = (text: string) => setEdit(text === serverDraft ? null : { text, base: serverDraft });

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

  // The agents that have worked on this ticket: its cluster's, and the QA
  // agent once there is one. The one shown first is whichever is acting on
  // the ticket now - QA while it is on the QA branch.
  const agents: AgentTarget[] = [];
  if (cluster) agents.push({ id: cluster.id, label: "Cluster agent", available: Boolean(cluster.windowId) });
  if (batch.qa) agents.push({ id: "qa", label: "QA agent", available: Boolean(batch.qa.windowId) });
  const preferredAgent = onQaBranch || !cluster ? "qa" : cluster.id;

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

      {ticket && agents.some((a) => a.available) && (
        <AgentTerminal
          batchId={batch.id}
          agents={agents}
          preferred={preferredAgent}
          onOpenTerminal={(agent) => (agent === "qa" ? onOpenQaTerminal() : onOpenTerminal(agent))}
        />
      )}

      {ticket && (
        <>
          {qaRunning && batch.qa && (
            <QaVerdicts
              batchId={batch.id}
              batchQa={batch.qa}
              ticket={ticket}
              issueKey={issueKey}
              busy={busy}
              onMerge={() => onMergeTicket(issueKey)}
              onChange={(text) => onRequestChange(issueKey, text)}
              onApprove={(notes) => onApproveQa(issueKey, notes)}
              onExclude={(why) => onExcludeQa(issueKey, why)}
              onRefine={(note) => onRefineNote(issueKey, note)}
              onClearRefine={() => onClearRefine(issueKey)}
              onReopen={() => onReopen(issueKey)}
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

          {ticket.state === "done" && !(qaRunning && integration === "approved") && !(integration === "approved" && batch.qa?.state === "shipped") && (
            <div className="jira-bdetail-actions">
              <span className="jira-bdetail-hint">
                {integration === "approved" ? "Approved on the QA branch." : "Accepted."}
              </span>
              <button
                className="jira-selaction"
                disabled={busy}
                onClick={() => onReopen(issueKey)}
                title="Take it back to review, where you can send feedback for rework"
              >
                Reopen
              </button>
            </div>
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
  batchId,
  batchQa,
  ticket,
  issueKey,
  busy,
  onMerge,
  onChange,
  onApprove,
  onExclude,
  onRefine,
  onClearRefine,
  onReopen,
}: {
  batchId: string;
  batchQa: BatchQa;
  ticket: TicketState;
  issueKey: string;
  busy: boolean;
  onMerge: () => void;
  onChange: (text: string) => void;
  onApprove: (notes: { note: string; refinedNote: string; postedNote: string }) => void;
  onExclude: (why: string) => void;
  onRefine: (note: string) => void;
  onClearRefine: () => void;
  onReopen: () => void;
}) {
  const integration = ticket.integration;
  const state = integration?.state ?? "none";
  // The form's state lives outside the component (stickyState), per ticket,
  // so switching tabs or views mid-sentence keeps what was typed. It is tied
  // to the QA state it was started in: when that moves under it - merged,
  // fixed, excluded - the half-written verdict belonged to the previous
  // situation and is dropped.
  const prefix = `qav:${batchId}:${issueKey}:`;
  const [mode, setMode] = useStickyState<VerdictMode>(`${prefix}mode`, "idle");
  const [text, setText] = useStickyState(`${prefix}text`, "");
  const [forState, setForState] = useStickyState<string | null>(`${prefix}for`, null);
  // What will be posted, once the reviewer edits the refined note. Null
  // means "the refined note as it came back".
  const [postedEdit, setPostedEdit] = useStickyState<string | null>(`${prefix}posted`, null);
  const refine = integration?.refine ?? null;
  const posted = postedEdit ?? refine?.refined ?? "";

  useEffect(() => {
    if (forState !== null && forState !== state) clearSticky(prefix);
  }, [forState, state, prefix]);

  const begin = (next: VerdictMode) => {
    setForState(state);
    setMode(next);
  };

  const reset = () => {
    clearSticky(prefix);
    setMode("idle");
    if (refine) onClearRefine();
  };

  const startRefine = () => {
    const note = text.trim();
    if (!note) {
      onApprove({ note: "", refinedNote: "", postedNote: "" });
      clearSticky(prefix);
      setMode("idle");
      return;
    }
    setPostedEdit(null);
    onRefine(note);
  };

  const approveWith = (postedNote: string) => {
    onApprove({
      note: refine?.note ?? text.trim(),
      refinedNote: refine && refine.state === "done" && !refine.asWritten ? refine.refined : "",
      postedNote,
    });
    clearSticky(prefix);
    setMode("idle");
  };

  // A refine request on the ticket is an approval in progress, whatever this
  // browser's form was doing - it may have been asked from another one.
  const approving = mode === "approve" || refine !== null;

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
          <button className="jira-selaction" disabled={busy} onClick={() => begin("exclude")} title="Leave it out of this run - nothing to drop, it was never merged">
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

      {integration?.commit && (state === "merged" || state === "fixing" || state === "approved") && (
        <QaDiff
          batchId={batchId}
          issueKey={issueKey}
          version={`${integration.commit}|${state}|${integration.fixed}|${integration.at ?? ""}`}
        />
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
          {batchQa.state !== "shipped" && (
            <div className="jira-qav-row">
              <button
                className="jira-selaction"
                disabled={busy}
                onClick={onReopen}
                title="Take the approval back: the ticket goes back to verifying, where you can request a change or approve it again"
              >
                Reopen
              </button>
            </div>
          )}
        </div>
      )}

      {(state === "merged" || state === "fixing") && mode === "idle" && !approving && (
        <div className="jira-qav-row">
          <button className="jira-selaction primary" disabled={busy} onClick={() => begin("approve")} title="Keep it, mark the ticket done">
            Approve
          </button>
          <button className="jira-selaction" disabled={busy} onClick={() => begin("change")} title="Ask the QA agent to change something, without committing">
            {state === "fixing" ? "Request another change" : "Request a change"}
          </button>
          <span className="jira-qav-spacer" />
          <button className="jira-selaction" disabled={busy} onClick={() => begin("exclude")} title="Leave it out of this run">
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

      {approving && !refine && (
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
            <button
              className="jira-selaction primary"
              disabled={busy}
              onClick={startRefine}
              title={text.trim() ? (batchQa.windowId ? "The QA agent restates it for a teammate who was not here" : "Restate it for a teammate who was not here") : undefined}
            >
              {text.trim() ? "Continue" : "Approve"}
            </button>
            <button className="jira-selaction" disabled={busy} onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {refine && refine.state === "pending" && (
        <div className="jira-qav-form">
          <div className="jira-qav-field">
            <b>Your note</b>
            <span className="jira-qav-note">{refine.note}</span>
          </div>
          <span className="jira-qav-hint">
            {refine.by === "qa-agent" ? "The QA agent is restating it..." : "Refining the note..."}
          </span>
          <div className="jira-qav-row">
            <button className="jira-selaction" disabled={busy} onClick={() => approveWith(refine.note)} title="Approve now, posting exactly what you typed">
              Approve with mine as written
            </button>
            <button className="jira-selaction" disabled={busy} onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {refine && refine.state === "done" && (
        <div className="jira-qav-form">
          <div className="jira-qav-field">
            <b>Your note</b>
            <span className="jira-qav-note">{refine.note}</span>
          </div>
          <label className="jira-qav-label">
            {refine.asWritten
              ? "Will be posted as written (it could not be restated without guessing)"
              : `Will be posted to ${issueKey}${refine.by === "qa-agent" ? " - restated by the QA agent" : ""}`}
            <textarea className="jira-bfeedback-box refined" rows={3} value={posted} onChange={(e) => setPostedEdit(e.target.value)} />
          </label>
          <div className="jira-qav-row">
            <button className="jira-selaction primary" disabled={busy || !posted.trim()} onClick={() => approveWith(posted.trim())}>
              Approve
            </button>
            {!refine.asWritten && posted !== refine.note && (
              <button className="jira-selaction" disabled={busy} onClick={() => setPostedEdit(refine.note)} title="Post exactly what you typed">
                Post mine as written
              </button>
            )}
            <button
              className="jira-selaction"
              disabled={busy}
              onClick={() => {
                setText(refine.note);
                setPostedEdit(null);
                setForState(state);
                setMode("approve");
                onClearRefine();
              }}
              title="Edit your note and restate it again"
            >
              Rewrite
            </button>
            <button className="jira-selaction" disabled={busy} onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
