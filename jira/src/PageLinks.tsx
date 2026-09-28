// Links to a ticket's page on the dev server that has its change: the
// cluster agent's while the ticket is in review or done, the QA agent's once
// it is on the QA branch. Which page is the one its QA report names (or the
// hand-off's override); the server is whatever is listening in that agent's
// terminals, looked up again every few seconds, since a server comes and
// goes with the agent that runs it.
import { useEffect, useState } from "react";
import { getAgentPorts, getProxyDomain, type AgentPortsResponse } from "./batchApi";
import { pagePath, portPageUrl, previewPageUrl } from "./pageLink";

const POLL_MS = 10_000;

export interface PageLinksProps {
  batchId: string;
  // A cluster id or "qa".
  agent: string;
  // "cluster agent" / "QA agent", for the line that says none is running.
  agentLabel: string;
  page: string;
}

export default function PageLinks({ batchId, agent, agentLabel, page }: PageLinksProps) {
  const [data, setData] = useState<AgentPortsResponse | null>(null);
  const [proxyDomain, setProxyDomain] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getProxyDomain().then((domain) => {
      if (!cancelled) setProxyDomain(domain);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null);
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        try {
          const res = await getAgentPorts(batchId, agent);
          if (!stopped) setData(res);
        } catch {
          // No agent to ask (never started): nothing to link to.
          if (!stopped) setData({ agent, session: "", ports: [], previewUrl: "" });
        }
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [batchId, agent]);

  const path = pagePath(page);
  if (!data) return <span className="jira-pagelink">{path}</span>;
  const place = { protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin };
  const links: { href: string; label: string; title: string }[] = [];
  const preview = data.previewUrl ? previewPageUrl(data.previewUrl, page) : "";
  if (preview) links.push({ href: preview, label: "QA preview", title: `${preview} - the URL the QA agent gave for its server` });
  for (const entry of data.ports) {
    const href = portPageUrl(entry.port, page, place, proxyDomain);
    if (href === preview) continue;
    links.push({ href, label: `:${entry.port}`, title: `${href}${entry.process ? ` - ${entry.process}` : ""}` });
  }

  // The page is the link, to the first server; any other server the agent
  // runs follows as a small port link.
  if (links.length === 0) {
    return (
      <span className="jira-pagelink" title={`No server is running in the ${agentLabel}'s terminals`}>
        {path}
      </span>
    );
  }
  const [first, ...rest] = links;
  return (
    <span className="jira-pagelink">
      <a className="jira-linkish" href={first.href} target="_blank" rel="noreferrer" title={first.title}>
        {path}
      </a>
      {rest.map((link) => (
        <a key={link.href} className="jira-linkish jira-pagelink-more" href={link.href} target="_blank" rel="noreferrer" title={link.title}>
          {link.label}
        </a>
      ))}
    </span>
  );
}
