// A ticket's Review section in the detail pane: the links a review would use,
// each task's state with what can be done about it, the two reports, and the
// buttons that publish them. Only reads the review; every action is a prop.
import Icon from "./Icon";
import type {
  CodeReport,
  PageShot,
  PreviewLink,
  PrLink,
  QaReportOfReview,
  Review,
  ReviewTask,
  ReviewTaskName,
  TicketLinks,
} from "./reviewTypes";
import { reviewShotSrc } from "./reviewApi";

const TASK_LABEL: Record<ReviewTaskName, string> = { code: "Code review", qa: "Visual QA" };
const STATE_LABEL = { running: "running", reported: "reported", stopped: "stopped", failed: "failed" } as const;
const VERDICT_LABEL = { approve: "approve", "request-changes": "request changes", comment: "comment" } as const;
const SHOT_LABEL: Record<PageShot, string> = {
  "before-1440": "live 1440",
  "after-1440": "preview 1440",
  "before-390": "live 390",
  "after-390": "preview 390",
};
const SHOTS: PageShot[] = ["before-1440", "after-1440", "before-390", "after-390"];

export interface ReviewDetailProps {
  issueKey: string;
  links: TicketLinks;
  review: Review | null;
  picked: { pr: string; preview: string };
  busy: boolean;
  // The last refusal from a review action, shown in the section.
  error: string | null;
  onPick: (kind: "pr" | "preview", url: string) => void;
  onOpenTerminal: (task: ReviewTaskName) => void;
  onStop: (task: ReviewTaskName) => void;
  onRunAgain: (task: ReviewTaskName, x: number, y: number) => void;
  onClose: () => void;
  onPostPr: () => void;
  onPostJira: () => void;
  onOpenShot: (src: string, opener: HTMLElement | null) => void;
}

function when(at: number): string {
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function prChip(pr: PrLink): string {
  return `#${pr.number}`;
}

function previewChip(preview: PreviewLink): string {
  return preview.kind === "editor" ? `${preview.themeId} (editor)` : preview.themeId;
}

function Chips<T extends { url: string; author: string | null; at: string | null }>({
  title,
  items,
  selected,
  label,
  onPick,
  busy,
}: {
  title: string;
  items: T[];
  selected: string;
  label: (item: T) => string;
  onPick: (url: string) => void;
  busy: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="jira-rv-links">
      <span className="jira-rv-links-title">{title}</span>
      {items.map((item) => (
        <button
          key={item.url}
          className={`jira-rv-chip${item.url === selected ? " picked" : ""}`}
          aria-pressed={item.url === selected}
          disabled={busy}
          title={`${item.url}${item.author ? `\nposted by ${item.author}` : ""}${item.at ? ` on ${item.at.slice(0, 10)}` : ""}`}
          onClick={() => onPick(item.url)}
        >
          {label(item)}
        </button>
      ))}
    </div>
  );
}

function TaskRow<R>({
  name,
  task,
  busy,
  onOpenTerminal,
  onStop,
  onRunAgain,
}: {
  name: ReviewTaskName;
  task: ReviewTask<R> | null;
  busy: boolean;
  onOpenTerminal: () => void;
  onStop: () => void;
  onRunAgain: (x: number, y: number) => void;
}) {
  if (!task) return null;
  return (
    <div className="jira-rv-task">
      <span className={`jira-rv-state state-${task.state}`}>
        {TASK_LABEL[name]} · {STATE_LABEL[task.state]}
      </span>
      {task.state === "running" ? (
        <>
          <button className="jira-selaction" disabled={busy || !task.windowId} onClick={onOpenTerminal}>
            Open terminal
          </button>
          <button className="jira-selaction" disabled={busy} onClick={onStop}>
            Stop
          </button>
        </>
      ) : (
        <button className="jira-selaction" disabled={busy} onClick={(e) => onRunAgain(e.clientX, e.clientY)}>
          Run again
        </button>
      )}
      {task.state === "failed" && task.error && <div className="jira-rv-error">{task.error}</div>}
    </div>
  );
}

function CodeReportView({ report }: { report: CodeReport }) {
  return (
    <div className="jira-rv-report">
      <div className={`jira-rv-verdict verdict-${report.verdict}`}>Code review · {VERDICT_LABEL[report.verdict]}</div>
      <p className="jira-rv-summary">{report.summary}</p>
      {report.findings.length > 0 && (
        <ul className="jira-rv-findings">
          {report.findings.map((finding, i) => (
            <li key={i}>
              <span className={`jira-rv-sev sev-${finding.severity}`}>{finding.severity}</span>
              <span className="jira-rv-finding">
                {finding.file && (
                  <code className="jira-rv-where">
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ""}
                  </code>
                )}
                {finding.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="jira-qa-list">
      <b>{title}</b>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function QaReportView({
  issueKey,
  report,
  onOpenShot,
}: {
  issueKey: string;
  report: QaReportOfReview;
  onOpenShot: (src: string, opener: HTMLElement | null) => void;
}) {
  return (
    <div className="jira-rv-report">
      <div className={`jira-rv-verdict qa-${report.status}`}>Visual QA · {report.status}</div>
      <List title="Checked" items={report.checked} />
      <List title="Wrong" items={report.wrong} />
      <List title="Notes" items={report.notes} />
      {report.pages.map((page) => (
        <div key={page.slug} className="jira-rv-page">
          <code className="jira-rv-page-path">{page.page}</code>
          <div className="jira-rv-shots">
            {SHOTS.map((which) => {
              const image = page.images[which];
              const src = reviewShotSrc(issueKey, page.slug, which);
              return image ? (
                <button key={which} className="jira-rv-shot" onClick={(e) => onOpenShot(src, e.currentTarget)} title={`${page.page}, ${SHOT_LABEL[which]}`}>
                  <img src={src} alt={`${page.page}, ${SHOT_LABEL[which]}`} loading="lazy" />
                  <span>{SHOT_LABEL[which]}</span>
                </button>
              ) : (
                <div key={which} className="jira-rv-shot missing">
                  <span>{SHOT_LABEL[which]}: none</span>
                </div>
              );
            })}
            {page.extras.map((extra) => {
              const src = reviewShotSrc(issueKey, page.slug, extra.label);
              return (
                <button key={extra.label} className="jira-rv-shot" onClick={(e) => onOpenShot(src, e.currentTarget)} title={extra.caption}>
                  <img src={src} alt={extra.caption || extra.label} loading="lazy" />
                  <span>{extra.caption || extra.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ReviewDetail({
  issueKey,
  links,
  review,
  picked,
  busy,
  error,
  onPick,
  onOpenTerminal,
  onStop,
  onRunAgain,
  onClose,
  onPostPr,
  onPostJira,
  onOpenShot,
}: ReviewDetailProps) {
  const code = review?.tasks.code ?? null;
  const qa = review?.tasks.qa ?? null;
  const running = code?.state === "running" || qa?.state === "running";
  const lastReport = Math.max(code?.report?.at ?? 0, qa?.report?.at ?? 0);
  const posted = review?.posted;

  return (
    <section className="jira-rv">
      <header className="jira-rv-head">
        <span className="jira-bdetail-title">Review</span>
        {review && !running && (review.worktreePath || code?.windowId || qa?.windowId) && (
          <button className="jira-linkish" disabled={busy} onClick={onClose} title="Remove the review's worktree and terminals; the reports stay">
            Close review
          </button>
        )}
      </header>

      <Chips title="PR" items={links.prs} selected={picked.pr} label={prChip} onPick={(url) => onPick("pr", url)} busy={busy || running} />
      <Chips
        title="Preview"
        items={links.previews}
        selected={picked.preview}
        label={previewChip}
        onPick={(url) => onPick("preview", url)}
        busy={busy || running}
      />

      {error && <div className="jira-rv-error">{error}</div>}
      {!review && <p className="jira-bdetail-note">Not reviewed yet. Review in the header runs it.</p>}

      <TaskRow
        name="code"
        task={code}
        busy={busy}
        onOpenTerminal={() => onOpenTerminal("code")}
        onStop={() => onStop("code")}
        onRunAgain={(x, y) => onRunAgain("code", x, y)}
      />
      {code?.report && <CodeReportView report={code.report} />}

      <TaskRow
        name="qa"
        task={qa}
        busy={busy}
        onOpenTerminal={() => onOpenTerminal("qa")}
        onStop={() => onStop("qa")}
        onRunAgain={(x, y) => onRunAgain("qa", x, y)}
      />
      {qa?.report && <QaReportView issueKey={issueKey} report={qa.report} onOpenShot={onOpenShot} />}

      {(code?.report || qa?.report) && (
        <div className="jira-rv-post">
          <button className="jira-selaction" disabled={busy || !code?.report} onClick={onPostPr} title="Post the code review to the pull request from your gh account">
            <Icon name="github" /> Post to PR
          </button>
          <button className="jira-selaction" disabled={busy} onClick={onPostJira} title="Add the reports to the ticket as one Jira comment">
            Post to Jira
          </button>
          {posted?.pr && (
            <span className="jira-rv-posted">
              PR review <a href={posted.pr.url} target="_blank" rel="noopener noreferrer">posted {when(posted.pr.at)}</a>
              {posted.pr.at < lastReport ? " (before the newest report)" : ""}
            </span>
          )}
          {posted?.jira && (
            <span className="jira-rv-posted">
              Jira comment posted {when(posted.jira.at)}
              {posted.jira.at < lastReport ? " (before the newest report)" : ""}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
