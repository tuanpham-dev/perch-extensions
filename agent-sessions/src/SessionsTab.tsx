import { useCallback, useEffect, useMemo, useState } from "react";
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
  const [sessions, setSessions] = useState<ListedSession[] | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState("all");
  const [selected, setSelected] = useState<string | null>(() => takePendingSelection());
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 700px)").matches);

  const load = useCallback(() => {
    setError(null);
    call<{ sessions: ListedSession[]; agents: string[] }>(`/sessions?cwd=${encodeURIComponent(cwd)}`)
      .then((d) => {
        setSessions(d.sessions);
        setAgents(d.agents);
      })
      .catch((err: Error) => setError(err.message));
  }, [cwd]);

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

  const agentLabels = useMemo(() => [...new Set((sessions ?? []).map((s) => s.agentLabel))], [sessions]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sessions ?? []).filter(
      (s) => (agentFilter === "all" || s.agentLabel === agentFilter) && (!q || s.title.toLowerCase().includes(q)),
    );
  }, [sessions, query, agentFilter]);
  const current = (sessions ?? []).find((s) => selectionKey(s) === selected) ?? null;

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

  const showList = !narrow || !current;
  const showPreview = !narrow || current;

  return (
    <div className={`agent-sessions${active ? "" : " hidden"}${narrow ? " narrow" : ""}`}>
      <div className="as-toolbar">
        <div className="as-heading">
          Agent Sessions · <span className="as-project">{basename(cwd)}</span>
        </div>
        <input
          className="as-search"
          type="search"
          placeholder="Search titles"
          aria-label="Search titles"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
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
          <div className="as-list" role="listbox" aria-label="Conversations">
            {sessions === null && !error && <div className="as-muted as-pad">Loading conversations…</div>}
            {sessions?.length === 0 && (
              <div className="as-muted as-pad">
                No agent conversations for this folder yet.
                {agents.length > 0 && ` Looked for ${agents.join(", ")}.`}
              </div>
            )}
            {sessions && sessions.length > 0 && visible.length === 0 && <div className="as-muted as-pad">Nothing matches.</div>}
            {visible.map((s) => {
              const key = selectionKey(s);
              return (
                <button
                  key={key}
                  role="option"
                  aria-selected={key === selected}
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
