import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  basename,
  call,
  cwdOfTab,
  host,
  relativeTime,
  selectionKey,
  takePendingSelection,
  type ListedSession,
  type SessionMessage,
} from "./host";

// Which conversations the tab lists: this project's, or every project's the
// app knows (open, recent and pinned), like Jira's "Assigned to me | Project"
// switch. Remembered across tabs and reloads.
type Scope = "project" | "all";
const SCOPE_KEY = "perch.agentSessions.scope";

function loadScope(): Scope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "project";
  } catch {
    return "project";
  }
}

function saveScope(scope: Scope): void {
  try {
    localStorage.setItem(SCOPE_KEY, scope);
  } catch {
    // this tab only
  }
}

// Every project folder the app knows: the projects open in the sidebar
// (core's /api/sessions) and the recent and pinned ones (the settings
// document's `projects`), with this tab's own first.
async function knownProjects(own: string): Promise<string[]> {
  const [sessions, doc] = await Promise.all([
    fetch("/api/sessions")
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []) as Promise<{ name: string; path: string }[]>,
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({})) as Promise<{ projects?: { cwd?: unknown }[] }>,
  ]);
  const folders = [
    own,
    ...sessions.filter((s) => !s.name.startsWith("perch-view-")).map((s) => s.path),
    ...(Array.isArray(doc.projects) ? doc.projects.map((p) => p.cwd).filter((c): c is string => typeof c === "string") : []),
  ];
  return [...new Set(folders.filter(Boolean))];
}

// In All projects, the projects to show: none picked means every one.
// Remembered by folder, so a project that comes back later is still picked.
const PROJECTS_KEY = "perch.agentSessions.projects";

function loadPickedProjects(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function savePickedProjects(picked: string[]): void {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(picked));
  } catch {
    // this tab only
  }
}

// A dropdown of checkboxes, one per project in the list, with its count.
function ProjectFilter({
  projects,
  picked,
  onChange,
}: {
  projects: { folder: string; count: number }[];
  picked: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const shown = picked.filter((p) => projects.some((x) => x.folder === p));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const label =
    shown.length === 0 ? "All projects" : shown.length === 1 ? basename(shown[0]) : `${shown.length} projects`;
  const toggle = (folder: string) =>
    onChange(picked.includes(folder) ? picked.filter((p) => p !== folder) : [...picked, folder]);

  return (
    <div className="as-projects" ref={rootRef}>
      <button
        className={`as-filter as-projects-button${shown.length ? " filtered" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        title={shown.length ? shown.join("\n") : "Show only some projects"}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="as-projects-label">{label}</span>
        <span className="codicon codicon-chevron-down" aria-hidden="true" />
      </button>
      {open && (
        <div className="as-projects-menu" role="group" aria-label="Projects">
          <label className="as-projects-item">
            <input type="checkbox" checked={shown.length === 0} onChange={() => onChange([])} />
            <span className="as-projects-name">All projects</span>
          </label>
          <div className="as-projects-sep" />
          {projects.map((p) => (
            <label key={p.folder} className="as-projects-item" title={p.folder}>
              <input type="checkbox" checked={picked.includes(p.folder)} onChange={() => toggle(p.folder)} />
              <span className="as-projects-name">{basename(p.folder)}</span>
              <span className="as-scope-count">{p.count}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentMark({ session }: { session: ListedSession }) {
  if (session.iconUrl) return <img className="as-mark" src={session.iconUrl} alt="" aria-hidden="true" />;
  return <span className={`as-mark codicon codicon-${session.icon || "hubot"}`} aria-hidden="true" />;
}

function Preview({ session, onResume, resuming, error }: { session: ListedSession; onResume: () => void; resuming: boolean; error: string | null }) {
  const [messages, setMessages] = useState<SessionMessage[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMessages(null);
    setFailed(false);
    const q = `/messages?agent=${encodeURIComponent(session.agentId)}&id=${encodeURIComponent(session.id)}&cwd=${encodeURIComponent(session.cwd)}`;
    call<{ messages: SessionMessage[] }>(q)
      .then((d) => !cancelled && setMessages(d.messages))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [session.agentId, session.id, session.cwd]);

  return (
    <div className="as-preview">
      <div className="as-preview-head">
        <div className="as-preview-title">{session.title}</div>
        <div className="as-preview-meta">
          {session.agentLabel}
          {session.branch ? ` · ${session.branch}` : ""} · {relativeTime(session.lastActiveAt)} · {session.messageCount} messages
        </div>
        <div className="as-preview-actions">
          {session.openIn ? (
            <button className="as-button primary" onClick={onResume}>
              Go to Window
            </button>
          ) : session.canResume ? (
            <button className="as-button primary" disabled={resuming} onClick={onResume}>
              {resuming ? "Opening…" : "Resume"}
            </button>
          ) : (
            <span className="as-muted">{session.agentLabel} can't reopen a chosen conversation.</span>
          )}
        </div>
        {error && <div className="as-error">{error}</div>}
      </div>
      <div className="as-messages">
        {failed || (messages && messages.length === 0 && !session.messageCount) ? (
          <div className="as-muted as-pad">Couldn't read this conversation.</div>
        ) : messages === null ? (
          <div className="as-muted as-pad">Loading…</div>
        ) : (
          messages.map((m, i) =>
            m.role === "tool" ? (
              <div key={i} className="as-msg as-tool">
                <span className="codicon codicon-tools" aria-hidden="true" /> {m.text}
              </div>
            ) : (
              <div key={i} className={`as-msg as-${m.role}`}>
                <div className="as-role">{m.role === "user" ? "You" : session.agentLabel}</div>
                <div className="as-text">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                    {m.text.length > 6000 ? `${m.text.slice(0, 6000)}…` : m.text}
                  </ReactMarkdown>
                </div>
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}

export function SessionsTab({ filePath, active }: { filePath: string; active: boolean }) {
  const cwd = cwdOfTab(filePath);
  const [scope, setScopeState] = useState<Scope>(loadScope);
  const [projectSessions, setProjectSessions] = useState<ListedSession[] | null>(null);
  const [allSessions, setAllSessions] = useState<ListedSession[] | null>(null);
  const sessions = scope === "all" ? allSessions : projectSessions;
  const [agents, setAgents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState("all");
  const [pickedProjects, setPickedProjectsState] = useState<string[]>(loadPickedProjects);
  const setPickedProjects = (next: string[]) => {
    setPickedProjectsState(next);
    savePickedProjects(next);
  };
  const [selected, setSelected] = useState<string | null>(() => takePendingSelection());
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 700px)").matches);

  const load = useCallback(() => {
    setError(null);
    call<{ sessions: ListedSession[]; agents: string[] }>(`/sessions?cwd=${encodeURIComponent(cwd)}`)
      .then((d) => {
        setProjectSessions(d.sessions);
        setAgents(d.agents);
      })
      .catch((err: Error) => setError(err.message));
    if (scope !== "all") return;
    knownProjects(cwd)
      .then((folders) =>
        call<{ sessions: ListedSession[]; agents: string[] }>("/sessions/all", {
          method: "POST",
          body: JSON.stringify({ folders }),
        }),
      )
      .then((d) => setAllSessions(d.sessions))
      .catch((err: Error) => setError(err.message));
  }, [cwd, scope]);

  const setScope = (next: Scope) => {
    setScopeState(next);
    saveScope(next);
  };

  useEffect(() => load(), [load]);

  // Refresh when the tab comes back into view, or the page does.
  useEffect(() => {
    if (active) load();
  }, [active, load]);
  useEffect(() => {
    const onVisible = () => !document.hidden && active && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [active, load]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 700px)");
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // A Ctrl+P pick on an already-open tab.
  useEffect(() => {
    if (!active) return;
    const pending = takePendingSelection();
    if (pending) setSelected(pending);
  }, [active]);

  // The projects All projects has conversations from, most first; a picked
  // project with none right now isn't offered (nor filtered on).
  const projectsInList = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of allSessions ?? []) counts.set(s.project ?? s.cwd, (counts.get(s.project ?? s.cwd) ?? 0) + 1);
    return [...counts.entries()]
      .map(([folder, count]) => ({ folder, count }))
      .sort((a, b) => b.count - a.count || basename(a.folder).localeCompare(basename(b.folder)));
  }, [allSessions]);
  // The picked projects the list has conversations from, in the menu's order.
  const pickedShown = projectsInList.filter((x) => pickedProjects.includes(x.folder)).map((x) => x.folder);
  const projectFilterOn = pickedShown.length > 0;

  const agentLabels = useMemo(() => [...new Set((sessions ?? []).map((s) => s.agentLabel))], [sessions]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sessions ?? []).filter(
      (s) =>
        (agentFilter === "all" || s.agentLabel === agentFilter) &&
        (scope !== "all" || !projectFilterOn || pickedProjects.includes(s.project ?? s.cwd)) &&
        (!q || s.title.toLowerCase().includes(q) || (scope === "all" && basename(s.project ?? s.cwd).toLowerCase().includes(q))),
    );
  }, [sessions, query, agentFilter, scope, projectFilterOn, pickedProjects]);
  const current = (sessions ?? []).find((s) => selectionKey(s) === selected) ?? null;
  const listRef = useRef<HTMLDivElement>(null);

  const resume = async (s: ListedSession) => {
    setResumeError(null);
    if (s.openIn) {
      host.app?.openSessionWindow?.(s.openIn.sessionName, { windowIndex: s.openIn.windowIndex });
      return;
    }
    setResuming(true);
    try {
      const r = await call<{ sessionName: string; windowIndex: number }>("/resume", {
        method: "POST",
        body: JSON.stringify({ agentId: s.agentId, id: s.id, cwd: s.cwd, title: s.title }),
      });
      host.app?.openSessionWindow?.(r.sessionName, { windowIndex: r.windowIndex });
      load();
    } catch (err) {
      setResumeError((err as Error).message);
    } finally {
      setResuming(false);
    }
  };

  // Arrow keys move through the listed conversations (from the search box
  // too) and Enter resumes the selected one. On a narrow screen selecting
  // opens the preview in place of the list, so there the arrows move focus
  // between rows and Enter opens the focused one's preview instead.
  const onListKey = (e: React.KeyboardEvent, fromSearch = false) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const rows = listRef.current ? [...listRef.current.querySelectorAll<HTMLElement>("[data-key]")] : [];
    const focusedAt = rows.findIndex((r) => r === document.activeElement);
    const at = narrow && focusedAt >= 0 ? focusedAt : visible.findIndex((s) => selectionKey(s) === selected);
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(visible.length - 1, at + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, at - 1);
    else if (!fromSearch && e.key === "Home") next = 0;
    else if (!fromSearch && e.key === "End") next = visible.length - 1;
    else if (e.key === "Enter") {
      const s = visible[at] ?? (fromSearch ? visible[0] : undefined);
      if (!s) return;
      e.preventDefault();
      if (narrow) setSelected(selectionKey(s));
      else void resume(s);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    const s = visible[next];
    if (!s) return;
    if (narrow) {
      rows[next]?.focus();
      return;
    }
    setSelected(selectionKey(s));
    setResumeError(null);
    if (fromSearch) rows[next]?.scrollIntoView({ block: "nearest" });
    else rows[next]?.focus();
  };

  const showList = !narrow || !current;
  const showPreview = !narrow || current;

  return (
    <div className={`agent-sessions${active ? "" : " hidden"}${narrow ? " narrow" : ""}`}>
      <div className="as-toolbar">
        <div className="as-heading">
          Agent Sessions ·{" "}
          <span className="as-project" title={scope === "all" && projectFilterOn ? pickedShown.join("\n") : undefined}>
            {scope !== "all" ? basename(cwd) : projectFilterOn ? pickedShown.map(basename).join(", ") : "All projects"}
          </span>
        </div>
        <div className="as-scope" role="tablist" aria-label="Which conversations">
          <button
            role="tab"
            aria-selected={scope === "project"}
            className={`as-scope-button${scope === "project" ? " active" : ""}`}
            title={cwd}
            onClick={() => setScope("project")}
          >
            This project
            {projectSessions && <span className="as-scope-count">{projectSessions.length}</span>}
          </button>
          <button
            role="tab"
            aria-selected={scope === "all"}
            className={`as-scope-button${scope === "all" ? " active" : ""}`}
            title="Every project open in the sidebar, recent or pinned"
            onClick={() => setScope("all")}
          >
            All projects
            {allSessions && <span className="as-scope-count">{allSessions.length}</span>}
          </button>
        </div>
        <input
          className="as-search"
          type="search"
          placeholder={scope === "all" ? "Search titles and projects" : "Search titles"}
          aria-label={scope === "all" ? "Search titles and projects" : "Search titles"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            onListKey(e, true);
          }}
        />
        {scope === "all" && allSessions && (
          <ProjectFilter projects={projectsInList} picked={pickedProjects} onChange={setPickedProjects} />
        )}
        <select className="as-filter" aria-label="Agent" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
          <option value="all">All agents</option>
          {agentLabels.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button className="as-icon" title="Refresh" aria-label="Refresh" onClick={load}>
          <span className="codicon codicon-refresh" aria-hidden="true" />
        </button>
      </div>
      {error && <div className="as-error as-pad">Couldn't list conversations: {error}</div>}
      <div className="as-body">
        {showList && (
          <div className="as-list" role="listbox" aria-label="Conversations" ref={listRef} onKeyDown={(e) => onListKey(e)}>
            {sessions === null && !error && (
              <div className="as-muted as-pad">{scope === "all" ? "Loading every project's conversations…" : "Loading conversations…"}</div>
            )}
            {sessions?.length === 0 && (
              <div className="as-muted as-pad">
                {scope === "all" ? "No agent conversations in any project yet." : "No agent conversations for this folder yet."}
                {agents.length > 0 && ` Looked for ${agents.join(", ")}.`}
              </div>
            )}
            {sessions && sessions.length > 0 && visible.length === 0 && <div className="as-muted as-pad">Nothing matches.</div>}
            {visible.map((s) => {
              const key = selectionKey(s);
              return (
                <button
                  key={key}
                  data-key={key}
                  role="option"
                  aria-selected={key === selected}
                  // One row in the Tab order: the selected one, else the first.
                  tabIndex={key === selected || (!visible.some((v) => selectionKey(v) === selected) && s === visible[0]) ? 0 : -1}
                  className={`as-row${key === selected ? " selected" : ""}`}
                  onClick={() => {
                    setSelected(key);
                    setResumeError(null);
                  }}
                  onDoubleClick={() => void resume(s)}
                >
                  <AgentMark session={s} />
                  <span className="as-row-main">
                    <span className="as-row-title">
                      {s.title}
                      {s.openIn && <span className="as-open">Open</span>}
                    </span>
                    <span className="as-row-meta">
                      {scope === "all" && (
                        <span className="as-row-project" title={s.cwd}>
                          {basename(s.project ?? s.cwd)} ·{" "}
                        </span>
                      )}
                      {s.agentLabel}
                      {s.branch ? ` · ${s.branch}` : ""} · {relativeTime(s.lastActiveAt)} · {s.messageCount} msgs
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {showPreview && (
          <div className="as-side">
            {narrow && current && (
              <button className="as-back" onClick={() => setSelected(null)}>
                <span className="codicon codicon-arrow-left" aria-hidden="true" /> Back
              </button>
            )}
            {current ? (
              <Preview session={current} onResume={() => void resume(current)} resuming={resuming} error={resumeError} />
            ) : (
              <div className="as-muted as-pad as-empty-preview">Select a conversation to preview it.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
