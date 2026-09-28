// What a batch agent's terminal shows, read-only, in the ticket's batch
// detail: the cluster agent working on the ticket, or the QA agent merging
// and fixing it. A look at what it is doing without leaving the board - the
// terminal itself is one click away for anything that needs typing.
//
// Polled rather than streamed: the server reads the screen through the
// host's capture call, which is a snapshot. Only while it is open and the
// page is visible, and slower once the window has gone, since nothing will
// change there until an agent is started again.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getAgentTerminal } from "./batchApi";
import type { AgentTerminalResponse } from "./batchTypes";
import Icon from "./Icon";

const POLL_MS = 1500;
const POLL_CLOSED_MS = 5000;
const LINES = 400;
// Within this many pixels of the bottom counts as following the output.
const STICK_PX = 24;

let rememberedOpen = false;

export interface AgentTarget {
  // A cluster id, or "qa".
  id: string;
  label: string;
  // Whether the agent has a terminal at all; one never started is listed
  // but not selectable.
  available: boolean;
}

export interface AgentTerminalProps {
  batchId: string;
  agents: AgentTarget[];
  // Which agent to show first: the one acting on the ticket right now.
  preferred: string;
  onOpenTerminal: (agentId: string) => void;
}

export default function AgentTerminal({ batchId, agents, preferred, onOpenTerminal }: AgentTerminalProps) {
  const [open, setOpen] = useState(rememberedOpen);
  const [agent, setAgent] = useState(preferred);
  const [data, setData] = useState<AgentTerminalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    stickRef.current = true;
  }, [batchId, agent]);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      let closed = false;
      if (document.visibilityState === "visible") {
        try {
          const res = await getAgentTerminal(batchId, agent, LINES);
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
  }, [open, batchId, agent]);

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

  const current = agents.find((a) => a.id === agent);
  const live = data?.agent === agent && !data.closed;

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
                title={a.available ? `Show the ${a.label} terminal` : `The ${a.label} has no terminal`}
                onClick={() => setAgent(a.id)}
              >
                {a.label}
              </button>
            ))}
          </span>
        )}
        {open && agents.length === 1 && current && <span className="jira-aterm-name">{current.label}</span>}
        {open && data?.agent === agent && (
          <span className={`jira-aterm-live${live ? " on" : ""}`} title={live ? "Refreshing every couple of seconds" : "The agent's terminal is closed"}>
            {live ? "live" : "closed"}
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
      {open && !error && !current?.available && <div className="jira-qav-hint">This agent has not been started.</div>}
      {open && !error && current?.available && data?.agent === agent && data.closed && (
        <div className="jira-qav-hint">The agent's terminal is closed.</div>
      )}
      {open && current?.available && (!data || (data.agent === agent && !data.closed)) && (
        <pre ref={preRef} className="jira-aterm-screen" onScroll={onScroll}>
          {data?.agent === agent ? data.text || " " : "Reading the terminal..."}
        </pre>
      )}
    </div>
  );
}
