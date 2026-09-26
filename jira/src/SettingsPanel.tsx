// The API token field, registered to render directly under jira.email - with
// the site URL and email it authenticates. (A core older than settings
// component placement renders it at the bottom of the section instead.) The token is deliberately not a manifest
// property: it lives in the host's per-extension secret store, which no
// client can read back. So this component only ever learns whether one is
// set (GET /token -> { set }), never its value, and drops what you typed as
// soon as the write lands.
import { useCallback, useEffect, useState } from "react";
import ProjectMapTable from "./ProjectMapTable";
import ProjectSettingsEditor from "./ProjectSettingsEditor";
import type { ProjectRow } from "./types";

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

let serverFetch: Fetcher | null = null;

export function setFetcher(fetcher: Fetcher): void {
  serverFetch = fetcher;
}

// What the project-mapping table needs that this component has no other way
// to reach: the settings document, and which repository the active window is
// in. A settings component is registered on its own, so it gets no context
// from the panes - client.tsx hands it this in activate().
export interface SettingsBridge {
  getSetting(key: string): unknown;
  setSetting(key: string, value: unknown): void;
  // The MAIN worktree of the active window's repository, once /status has
  // reported it. Null before that, or outside a repository.
  getActiveRepo(): string | null;
  // The Jira project that repository resolved to, once /status has said.
  getActiveProject(): string | null;
  // Fires whenever either of the above could have changed.
  subscribe(cb: () => void): () => void;
}

let bridge: SettingsBridge | null = null;

export function setSettingsBridge(next: SettingsBridge | null): void {
  bridge = next;
}

// The token is not a setting, so ctx.settings.onDidChange never fires for it —
// without this the sidebar panel would keep showing "add an API token" until
// something else made it refetch /status. Saving here tells it to re-check.
const tokenListeners = new Set<() => void>();

export function onTokenChange(cb: () => void): () => void {
  tokenListeners.add(cb);
  return () => tokenListeners.delete(cb);
}

// The site's projects, so the mapping table offers a list rather than a text
// field. Fetched here rather than threaded from the panes' store: this
// component is registered separately and may render with no pane open.
function useProjects(refreshKey: number): { projects: ProjectRow[]; error: string | null } {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverFetch) return;
    let alive = true;
    serverFetch("/projects")
      .then((res) => (res.ok ? res.json() : res.json().then((body) => Promise.reject(new Error(body?.error)))))
      .then((body: { projects: ProjectRow[] }) => {
        if (!alive) return;
        setProjects(body.projects ?? []);
        setError(null);
      })
      .catch((err: Error) => {
        // Not fatal: the table still lists what is mapped, it just can't
        // offer the site's other projects until Jira is reachable.
        if (alive) setError(err.message || "Could not list Jira projects.");
      });
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  return { projects, error };
}

// Re-renders when the settings document or the active repository changes, so
// the table below reflects a mapping written from the pane's picker without
// needing Settings to be reopened.
function useBridge(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => bridge?.subscribe(() => setTick((n) => n + 1)) ?? undefined, []);
  return tick;
}

export default function SettingsPanel() {
  const [set, setSet] = useState<boolean | null>(null);
  // False only on a core too old to store extension secrets. Undefined-safe:
  // a core that predates the field at all reports nothing, and is treated as
  // supported so nothing regresses for it.
  const [supported, setSupported] = useState(true);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!serverFetch) return;
    serverFetch("/token")
      .then((res) => res.json())
      .then((body: { set: boolean; supported?: boolean }) => {
        setSet(body.set);
        setSupported(body.supported !== false);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(refresh, [refresh]);

  const write = useCallback(
    async (next: string) => {
      if (!serverFetch) return;
      setBusy(true);
      setError(null);
      try {
        const res = await serverFetch("/token", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: next }),
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        setValue("");
        refresh();
        for (const cb of tokenListeners) cb();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // Deliberately the same markup and host classes as core's own API key field
  // (client/src/components/settings/AiSection.tsx's ApiKeyField): settings-row
  // wrapper, a settings-label whose trailing settings-hint carries the
  // stored/not-set state, dialog-input for the box, and dialog-button
  // primary/secondary for Save/Clear. Extensions render inside the app's DOM,
  // so reusing its classes is what keeps this field looking native in every
  // theme instead of falling back to the browser's own control styling.
  return (
    <div className="settings-row">
      <span className="settings-label">
        API token{" "}
        <span className="settings-hint">
          - {!supported ? "unavailable" : set === null ? "checking…" : set ? "stored" : "not set"}
        </span>
      </span>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          id="jira-api-token"
          className="dialog-input"
          style={{ flex: 1 }}
          type="password"
          autoComplete="off"
          placeholder={
            !supported
              ? "Update perch to store a token"
              : set
                ? "Stored - type to replace"
                : "Paste your Atlassian API token"
          }
          value={value}
          disabled={busy || !supported}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) void write(value);
          }}
        />
        <button
          className="dialog-button primary"
          disabled={busy || !supported || !value.trim()}
          onClick={() => void write(value)}
        >
          Save
        </button>
        {set && (
          <button className="dialog-button secondary" disabled={busy} onClick={() => void write("")}>
            Clear
          </button>
        )}
      </div>
      {error && <div className="settings-hint settings-error">{error}</div>}
    </div>
  );
}

// The project-mapping table, registered as its own settings component so it
// can sit directly under the jira.projectMap field it edits while the token
// field sits under jira.email - see client.tsx's registrations.
export function ProjectSettingsSetting() {
  const tick = useBridge();
  const { projects, error } = useProjects(tick);
  if (!bridge) return null;
  const current = bridge;
  return (
    <ProjectSettingsEditor
      raw={current.getSetting("jira.projectSettings")}
      globals={(key) => current.getSetting(key)}
      projects={projects}
      projectsError={error}
      activeProject={current.getActiveProject()}
      onChange={(value) => current.setSetting("jira.projectSettings", value)}
    />
  );
}

export function ProjectMapSettings() {
  const tick = useBridge();
  const { projects, error } = useProjects(tick);
  if (!bridge) return null;
  return (
    <ProjectMapTable
      raw={bridge.getSetting("jira.projectMap")}
      projects={projects}
      activeRepo={bridge.getActiveRepo()}
      projectsError={error}
      onChange={(value) => bridge?.setSetting("jira.projectMap", value)}
    />
  );
}

// The storefront password a review's QA agent enters on a password-protected
// store, one per Jira project, kept in the host's secret store beside the API
// token. Presence only, never the value - the same contract as the token.
export function StorefrontPasswordSetting() {
  const tick = useBridge();
  const { projects } = useProjects(tick);
  const active = bridge?.getActiveProject() ?? "";
  const [project, setProject] = useState("");
  const [set, setSet] = useState<boolean | null>(null);
  const [supported, setSupported] = useState(true);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = project || active || projects[0]?.key || "";

  const refresh = useCallback(() => {
    if (!serverFetch || !chosen) return;
    setSet(null);
    serverFetch(`/storefront-password?project=${encodeURIComponent(chosen)}`)
      .then((res) => res.json())
      .then((body: { set: boolean; supported?: boolean }) => {
        setSet(body.set);
        setSupported(body.supported !== false);
      })
      .catch((err: Error) => setError(err.message));
  }, [chosen]);

  useEffect(refresh, [refresh]);

  const write = async (next: string) => {
    if (!serverFetch || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      const res = await serverFetch("/storefront-password", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: chosen, value: next }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setValue("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-row">
      <span className="settings-label">
        Storefront password{" "}
        <span className="settings-hint">
          - {!chosen ? "pick a project" : !supported ? "unavailable" : set === null ? "checking…" : set ? "stored" : "not set"}
        </span>
      </span>
      <div className="settings-hint">For a password-protected store: the review QA agent enters it on the preview. One per Jira project.</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          id="jira-storefront-project"
          className="dialog-input"
          style={{ width: "auto", maxWidth: "16rem" }}
          value={chosen}
          disabled={busy}
          onChange={(e) => setProject(e.target.value)}
        >
          {!projects.some((row) => row.key === chosen) && chosen && <option value={chosen}>{chosen}</option>}
          {projects.map((row) => (
            <option key={row.key} value={row.key}>
              {row.key} - {row.name}
            </option>
          ))}
        </select>
        <input
          id="jira-storefront-password"
          className="dialog-input"
          style={{ flex: 1, minWidth: "10rem" }}
          type="password"
          autoComplete="off"
          placeholder={set ? "Stored - type to replace" : "The store's password page password"}
          value={value}
          disabled={busy || !supported || !chosen}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) void write(value);
          }}
        />
        <button className="dialog-button primary" disabled={busy || !supported || !value.trim() || !chosen} onClick={() => void write(value)}>
          Save
        </button>
        {set && (
          <button className="dialog-button secondary" disabled={busy} onClick={() => void write("")}>
            Clear
          </button>
        )}
      </div>
      {error && <div className="settings-hint settings-error">{error}</div>}
    </div>
  );
}
