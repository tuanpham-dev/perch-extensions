// The user's tabs, kept as one JSON string in the customTabs.tabs setting —
// server-synced, so the same tabs appear on every device. Where each tab sits
// and which panes it holds live in the host's own synced sidebar layout.

export interface TabRecord {
  // Extension-local id; the host namespaces it to ext.<extensionId>.<id>.
  id: string;
  title: string;
  icon: string;
  // The side the tab was created on. Only used the first time the host
  // places it; after that the host's layout remembers where it is.
  side: "left" | "right";
}

export interface SettingsApi {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  onDidChange(cb: () => void): () => void;
}

export const TABS_KEY = "customTabs.tabs";

// A write reaches settings.get only after the host's settings state updates
// (a render later), so until get returns what was last written, that write
// is the truth. Otherwise a sync in between would see a tab just created as
// deleted — and deleting a tab also sends its panes home.
let lastWritten: string | null = null;

// null when the stored value can't be read as a tab list (a half-typed hand
// edit of the JSON field). Callers must not treat that as "no tabs": deleting
// a tab also sends its panes home, so one stray keystroke would undo the
// user's whole arrangement.
export function readTabs(settings: SettingsApi): TabRecord[] | null {
  const stored = settings.get(TABS_KEY);
  if (lastWritten !== null && stored === lastWritten) lastWritten = null;
  return parseTabs(lastWritten ?? stored);
}

export function parseTabs(raw: unknown): TabRecord[] | null {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "string") return null;
  if (raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<string>();
  const tabs: TabRecord[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const { id, title, icon, side } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    if (typeof title !== "string" || !title.trim()) continue;
    seen.add(id);
    tabs.push({
      id,
      title,
      icon: typeof icon === "string" && icon ? icon : "layers",
      side: side === "right" ? "right" : "left",
    });
  }
  return tabs;
}

export function writeTabs(settings: SettingsApi, tabs: TabRecord[]): void {
  const value = tabs.length === 0 ? "" : JSON.stringify(tabs);
  lastWritten = value;
  settings.set(TABS_KEY, value);
}

// Forgets a pending write, for deactivation.
export function resetPendingWrite(): void {
  lastWritten = null;
}

// Stable across renames, and never a valid panel id of this extension (it
// registers none).
export function newTabId(): string {
  return `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
