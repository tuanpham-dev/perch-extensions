// What an agent's terminal shows, in a ticket's detail: a batch's cluster or
// QA agent, or a review's code or QA agent. A look at what it is doing
// without leaving the board, and - while it waits on a permission prompt -
// the answer to that prompt: its options as buttons, Esc, and a reply box.
// With no prompt it can read, it offers plain keys instead.
//
// Polled rather than streamed: the server reads the screen through the
// host's capture call, which is a snapshot. Only while it is open and the
// page is visible, and slower once the window has gone, since nothing will
// change there until an agent is started again.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentKeyAction, AgentTerminalResponse } from "./batchTypes";
import Icon from "./Icon";

const POLL_MS = 1500;
const POLL_CLOSED_MS = 5000;
const LINES = 400;
// Within this many pixels of the bottom counts as following the output.
const STICK_PX = 24;
// Keys offered when the prompt can't be read.
const FALLBACK_KEYS: { key: string; label: string }[] = [
  { key: "1", label: "1" },
  { key: "2", label: "2" },
  { key: "3", label: "3" },
  { key: "enter", label: "Enter" },
];

let rememberedOpen = false;

export interface AgentTarget {
  // A cluster id, "qa", or a review task.
  id: string;
  label: string;
  // Whether the agent has a terminal at all; one never started is listed
  // but not selectable.
  available: boolean;
  // Whether it ever ran: one that did and has no terminal now is closed,
  // not unstarted.
  started?: boolean;
}

// Where the terminal is read from and answers are sent: a batch's agents or
// a review's. `id` changes when the source does.
export interface AgentTerminalSource {
  id: string;
  load: (agent: string, lines: number) => Promise<AgentTerminalResponse>;
  send: (agent: string, action: AgentKeyAction, expect: string) => Promise<unknown>;
}

export interface AgentTerminalProps {
  source: AgentTerminalSource;
  agents: AgentTarget[];
  // Which agent to show first: the one acting on the ticket right now.
  preferred: string;
  onOpenTerminal: (agentId: string) => void;
}

export default function AgentTerminal({ source, agents, preferred, onOpenTerminal }: AgentTerminalProps) {
  const [open, setOpen] = useState(rememberedOpen);
  const [agent, setAgent] = useState(preferred);
  const [data, setData] = useState<AgentTerminalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [poke, setPoke] = useState(0);
  const preRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);

  // A different ticket, or the work moving to the other agent, shows the
  // agent now acting on it.
  useEffect(() => {
    setAgent(preferred);
  }, [preferred]);

  useEffect(() => {
    setData(null);
    setError(null);
    setReply("");
    stickRef.current = true;
  }, [source.id, agent]);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      let closed = false;
      if (document.visibilityState === "visible") {
        try {
          const res = await source.load(agent, LINES);
          if (stopped) return;
          setData(res);
          setError(null);
          closed = res.closed;
        } catch (err) {
          if (stopped) return;
          setError(err instanceof Error ? err.message : String(err));
          closed = true;
        }
      }
      if (!stopped) timer = setTimeout(tick, closed ? POLL_CLOSED_MS : POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // `poke` re-reads at once after an answer, rather than on the next tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source.id, agent, poke]);

  // Follows the output like a terminal does, unless you have scrolled up to
  // read something - then it stays where you are.
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (pre && stickRef.current) pre.scrollTop = pre.scrollHeight;
  }, [data?.text, open]);

  const onScroll = () => {
    const pre = preRef.current;
    if (pre) stickRef.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight <= STICK_PX;
  };

  const toggle = () => {
    rememberedOpen = !open;
    setOpen(!open);
  };

  const answer = async (action: AgentKeyAction) => {
    setSending(true);
    setError(null);
    try {
      await source.send(agent, action, data?.prompt?.signature ?? "");
      if (action.type === "text") setReply("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
      setPoke((n) => n + 1);
    }
  };

  const current = agents.find((a) => a.id === agent);
  const shown = data?.agent === agent ? data : null;
  const live = Boolean(shown && !shown.closed);
  const prompt = live ? (shown?.prompt ?? null) : null;
  const askingKeys = live && !prompt && Boolean(shown?.waiting);

  return (
    <div className="jira-aterm">
      <div className="jira-aterm-bar">
        <button className="jira-diff-toggle" onClick={toggle} aria-expanded={open}>
          <Icon name={open ? "chevron-down" : "chevron-right"} />
          <b>Agent terminal</b>
        </button>
        {open && agents.length > 1 && (
          <span className="jira-aterm-pick" role="tablist" aria-label="Which agent">
            {agents.map((a) => (
              <button
                key={a.id}
                role="tab"
                aria-selected={a.id === agent}
                className={`jira-aterm-agent${a.id === agent ? " active" : ""}`}
                disabled={!a.available}
                title={a.available ? `Show the ${a.label} terminal` : a.started ? `The ${a.label}'s terminal is closed` : `The ${a.label} has not been started`}
                onClick={() => setAgent(a.id)}
              >
                {a.label}
              </button>
            ))}
          </span>
        )}
        {open && agents.length === 1 && current && <span className="jira-aterm-name">{current.label}</span>}
        {open && shown && (
          <span
            className={`jira-aterm-live${prompt || askingKeys ? " waiting" : live ? " on" : ""}`}
            title={live ? "Refreshing every couple of seconds" : "The agent's terminal is closed"}
          >
            {prompt || askingKeys ? "waiting on you" : live ? "live" : "closed"}
          </span>
        )}
        <span className="jira-qav-spacer" />
        {open && current?.available && (
          <button className="icon-button" title="Open this terminal to type into it" onClick={() => onOpenTerminal(agent)}>
            <Icon name="terminal" />
          </button>
        )}
      </div>
      {open && error && <div className="jira-error">{error}</div>}
      {open && !error && !current?.available && (
        <div className="jira-qav-hint">{current?.started ? "The agent's terminal is closed." : "This agent has not been started."}</div>
      )}
      {open && !error && current?.available && shown?.closed && <div className="jira-qav-hint">The agent's terminal is closed.</div>}
      {open && current?.available && (!shown || !shown.closed) && (
        <pre ref={preRef} className="jira-aterm-screen" onScroll={onScroll}>
          {shown ? shown.text || " " : "Reading the terminal..."}
        </pre>
      )}
      {open && (prompt || askingKeys) && (
        <div className="jira-aterm-answer">
          {prompt && (prompt.question || prompt.title) && <div className="jira-aterm-question">{prompt.question || prompt.title}</div>}
          <div className="jira-aterm-options">
            {prompt
              ? prompt.options.map((option) => (
                  <button
                    key={option.n}
                    className="jira-selaction"
                    disabled={sending}
                    onClick={() => void answer({ type: "option", n: option.n })}
                  >
                    {option.n}. {option.label}
                  </button>
                ))
              : FALLBACK_KEYS.map((entry) => (
                  <button
                    key={entry.key}
                    className="jira-selaction"
                    disabled={sending}
                    title="The prompt couldn't be read - this sends the key as typed"
                    onClick={() => void answer({ type: "key", key: entry.key })}
                  >
                    {entry.label}
                  </button>
                ))}
            <button className="jira-selaction" disabled={sending} title="Cancel the prompt" onClick={() => void answer({ type: "key", key: "esc" })}>
              Esc
            </button>
          </div>
          <form
            className="jira-aterm-reply"
            onSubmit={(e) => {
              e.preventDefault();
              if (reply.trim()) void answer({ type: "text", text: reply });
            }}
          >
            <input
              className="jira-input"
              value={reply}
              disabled={sending}
              placeholder="Reply to the agent"
              aria-label="Reply to the agent"
              onChange={(e) => setReply(e.target.value)}
            />
            <button className="jira-selaction" type="submit" disabled={sending || !reply.trim()}>
              Send
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
