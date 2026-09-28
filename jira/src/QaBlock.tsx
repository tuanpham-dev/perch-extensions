// What QA concluded about one ticket: the verdict, what was wrong, what
// changed, how to check it, and the screenshots.
//
// The pictures are thumbnails on purpose - a reviewer scans the words first
// and opens an image when a claim needs checking. Clicking one hands off to
// the tab's viewer, which is where zooming lives.
import { useState } from "react";
import Icon from "./Icon";
import type { QaReport, QaStatus } from "./batchTypes";

export interface QaBlockProps {
  report: QaReport;
  // Earlier reports, oldest first. A ticket sent back for rework keeps what
  // the first pass claimed.
  history: QaReport[];
  issueKey: string;
  batchId: string;
  // When the reviewer last sent this ticket back. A report older than that
  // describes the page before the rework.
  lastFeedbackAt?: number | null;
  // An earlier report, shown under the current one: its pictures come from
  // where they were kept when it was replaced, and open in a browser tab.
  historical?: boolean;
  // "before", "after", or "shot-<n>" for one of the extras.
  onOpenShot: (which: string, opener: HTMLElement | null) => void;
  onOpenReport: (path: string) => void;
}

const STATUS_LABEL: Record<QaStatus, string> = {
  pass: "QA pass",
  fail: "QA fail",
  partial: "QA partial",
  blocked: "Blocked",
  unverified: "Unverified",
};

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="jira-qa-list">
      <b>{title}</b>
      <ul>
        {items.map((item, i) => (
          <li key={`${title}-${i}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function when(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function QaBlock({ report, history, issueKey, batchId, lastFeedbackAt, historical = false, onOpenShot, onOpenReport }: QaBlockProps) {
  const stale = !historical && Boolean(lastFeedbackAt && report.at < lastFeedbackAt);
  const [showHistory, setShowHistory] = useState(false);
  // The report's time rides on the URL: for the current report it only makes
  // the address change when the report does, so a replaced picture is
  // fetched again rather than served from the browser's cache.
  const shotUrl = (which: string) =>
    `/api/ext/perch.jira/qa/${encodeURIComponent(batchId)}/${encodeURIComponent(issueKey)}/${which}?${historical ? "at" : "v"}=${report.at}`;
  const openShot = (which: string, opener: HTMLElement) => {
    if (historical) window.open(shotUrl(which), "_blank", "noopener");
    else onOpenShot(which, opener);
  };
  const extras = report.shots ?? [];

  return (
    <section className="jira-qa">
      <header className="jira-qa-head">
        <span className={`jira-qa-status qa-${report.status}`}>{STATUS_LABEL[report.status]}</span>
        <span className="jira-qa-at">
          {report.source === "qa-agent" ? `updated by the QA agent ${when(report.at)}` : `reported ${when(report.at)}`}
        </span>
        {stale && (
          <span className="jira-qa-stale" title="Filed before the ticket was sent back for rework; a new report replaces it">
            from before the rework
          </span>
        )}
        {!historical && history.length > 0 && (
          <button className="jira-linkish" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)} title="Earlier passes, replaced after rework">
            {showHistory ? "Hide earlier reports" : history.length === 1 ? "1 earlier report" : `${history.length} earlier reports`}
          </button>
        )}
        {report.reportPath && (
          <button className="jira-linkish" onClick={() => onOpenReport(report.reportPath)} title={report.reportPath}>
            Open the full report
          </button>
        )}
      </header>

      {report.source === "qa-agent" && report.change && (
        <p className="jira-qa-revised" title="The change you asked for on the QA branch">
          After: <span>{report.change}</span>
        </p>
      )}

      {(report.before || report.after || extras.length > 0) && (
        <div className="jira-qa-shots">
          {/* The pair keeps its place at the front, and keeps its empty slot:
              "not captured" opposite an after shot is a fact about the QA,
              where a missing extra is just a shot nobody took. */}
          {(["before", "after"] as const).map((which) =>
            report[which] ? (
              <button key={which} className="jira-qa-shot" onClick={(event) => openShot(which, event.currentTarget)} title={`Open the ${which} screenshot`}>
                <span className="jira-qa-shot-label">
                  {which}
                  <Icon name="zoom-in" />
                </span>
                <img src={shotUrl(which)} alt={`${issueKey} ${which}`} loading="lazy" onError={historical ? (e) => { e.currentTarget.style.display = "none"; } : undefined} />
              </button>
            ) : (
              <div key={which} className="jira-qa-shot empty">
                <span className="jira-qa-shot-label">{which}</span>
                <span className="jira-qa-shot-none">not captured</span>
              </div>
            ),
          )}
          {extras.map((shot) => (
            <button
              key={shot.label}
              className="jira-qa-shot"
              onClick={(event) => openShot(shot.label, event.currentTarget)}
              title={shot.caption || `Open ${shot.label}`}
            >
              <span className="jira-qa-shot-label">
                <span className="jira-qa-shot-cap">{shot.caption || shot.label}</span>
                <Icon name="zoom-in" />
              </span>
              <img src={shotUrl(shot.label)} alt={`${issueKey} ${shot.caption || shot.label}`} loading="lazy" onError={historical ? (e) => { e.currentTarget.style.display = "none"; } : undefined} />
            </button>
          ))}
        </div>
      )}

      <List title="Problem" items={report.problem} />
      <List title="Fix" items={report.fix} />
      {report.steps.length > 0 && (
        <div className="jira-qa-list">
          <b>Steps to QA</b>
          <ol>
            {report.steps.map((step, i) => (
              <li key={`step-${i}`}>{step}</li>
            ))}
          </ol>
        </div>
      )}
      <List title="Notes" items={report.notes} />
      {report.files.length > 0 && (
        <p className="jira-qa-files" title={report.files.join("\n")}>
          Touched <span className="mono">{report.files.join(", ")}</span>
        </p>
      )}
      {showHistory && (
        <div className="jira-qa-history">
          {[...history].reverse().map((earlier) => (
            <QaBlock
              key={earlier.at}
              report={earlier}
              history={[]}
              issueKey={issueKey}
              batchId={batchId}
              historical
              onOpenShot={onOpenShot}
              onOpenReport={onOpenReport}
            />
          ))}
        </div>
      )}
    </section>
  );
}
