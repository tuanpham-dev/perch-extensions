// What QA concluded about one ticket: the verdict, what was wrong, what
// changed, how to check it, and the two screenshots.
//
// The pictures are thumbnails on purpose - a reviewer scans the words first
// and opens an image when a claim needs checking. Clicking one hands off to
// the tab's viewer, which is where zooming lives.
import Icon from "./Icon";
import type { QaReport, QaStatus } from "./batchTypes";

export interface QaBlockProps {
  report: QaReport;
  // Earlier reports, oldest first. A ticket sent back for rework keeps what
  // the first pass claimed.
  history: QaReport[];
  issueKey: string;
  batchId: string;
  onOpenShot: (which: "before" | "after", opener: HTMLElement | null) => void;
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

export default function QaBlock({ report, history, issueKey, batchId, onOpenShot, onOpenReport }: QaBlockProps) {
  const shotUrl = (which: "before" | "after") =>
    `/api/ext/perch.jira/qa/${encodeURIComponent(batchId)}/${encodeURIComponent(issueKey)}/${which}`;

  return (
    <section className="jira-qa">
      <header className="jira-qa-head">
        <span className={`jira-qa-status qa-${report.status}`}>{STATUS_LABEL[report.status]}</span>
        <span className="jira-qa-at">reported {when(report.at)}</span>
        {history.length > 0 && (
          <span className="jira-qa-at" title="An earlier pass was replaced after rework">
            {history.length === 1 ? "1 earlier report" : `${history.length} earlier reports`}
          </span>
        )}
        {report.reportPath && (
          <button className="jira-linkish" onClick={() => onOpenReport(report.reportPath)} title={report.reportPath}>
            Open the full report
          </button>
        )}
      </header>

      {(report.before || report.after) && (
        <div className="jira-qa-shots">
          {(["before", "after"] as const).map((which) =>
            report[which] ? (
              <button key={which} className="jira-qa-shot" onClick={(event) => onOpenShot(which, event.currentTarget)} title={`Open the ${which} screenshot`}>
                <span className="jira-qa-shot-label">
                  {which}
                  <Icon name="zoom-in" />
                </span>
                <img src={shotUrl(which)} alt={`${issueKey} ${which}`} loading="lazy" />
              </button>
            ) : (
              <div key={which} className="jira-qa-shot empty">
                <span className="jira-qa-shot-label">{which}</span>
                <span className="jira-qa-shot-none">not captured</span>
              </div>
            ),
          )}
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
    </section>
  );
}
