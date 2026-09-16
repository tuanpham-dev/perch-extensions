// Everything the three routes (tab strip menu, palette, Settings) do, in one
// place so they behave the same. The tab records are the source of truth;
// syncTabs makes the host's registered tabs match them.
import { newTabId, readTabs, resetPendingWrite, writeTabs, type SettingsApi, type TabRecord } from "./store";

type Side = "left" | "right";

export interface SidebarTabHandle {
  id: string;
  update(patch: { title?: string; icon?: string }): void;
  reveal(): void;
  remove(): void;
}

export interface PickItem {
  id: string;
  label: string;
  icon?: string;
  detail?: string;
  keywords?: string[];
}

export interface Host {
  settings: SettingsApi;
  registerSidebarTab(tab: { id: string; title: string; icon: string; side?: Side }): SidebarTabHandle;
  app: {
    confirmDialog(message: string, confirmLabel?: string): Promise<boolean>;
    promptDialog(message: string, defaultValue?: string): Promise<string | null>;
    pickItem(opts: { title: string; items: PickItem[]; current?: string; placeholder?: string }): Promise<string | null>;
    pickIcon(opts?: { title?: string; current?: string }): Promise<string | null>;
  };
}

let host: Host | null = null;
// Record id -> the host's handle for it.
const handles = new Map<string, SidebarTabHandle>();

export function init(next: Host | null): void {
  host = next;
  if (!next) {
    handles.clear();
    resetPendingWrite();
  }
}

// Registers a tab for every record and updates the ones already registered.
// A handle whose record is gone was deleted somewhere else (another device,
// or a hand edit of the setting), so the tab is deleted here too.
export function syncTabs(): void {
  if (!host) return;
  const tabs = readTabs(host.settings);
  // Unreadable (see readTabs): leave the registered tabs exactly as they are.
  if (tabs === null) return;
  const live = new Set(tabs.map((t) => t.id));
  for (const tab of tabs) {
    const handle = handles.get(tab.id);
    if (handle) handle.update({ title: tab.title, icon: tab.icon });
    else handles.set(tab.id, host.registerSidebarTab({ id: tab.id, title: tab.title, icon: tab.icon, side: tab.side }));
  }
  for (const [id, handle] of handles) {
    if (live.has(id)) continue;
    handles.delete(id);
    handle.remove();
  }
}

// The record behind a host tab id, when that tab is one of ours.
export function recordForTabId(tabId: string | null): TabRecord | undefined {
  if (!host || tabId === null) return undefined;
  for (const [id, handle] of handles) {
    if (handle.id === tabId) return currentTabs().find((t) => t.id === id);
  }
  return undefined;
}

// The tabs as registered right now. While the setting is unreadable that is
// the last list that was, rebuilt from the live handles' records.
let lastReadable: TabRecord[] = [];

function currentTabs(): TabRecord[] {
  if (!host) return [];
  const tabs = readTabs(host.settings);
  if (tabs !== null) lastReadable = tabs;
  return lastReadable;
}

export function listTabs(): TabRecord[] {
  return currentTabs();
}

// Whether the stored value can be read, for the Settings list's warning.
export function tabsSettingReadable(): boolean {
  return !host || readTabs(host.settings) !== null;
}

function save(tabs: TabRecord[]): void {
  if (!host) return;
  writeTabs(host.settings, tabs);
  syncTabs();
}

// Asks for a name until it gets a non-blank one or the user cancels.
async function askName(message: string, current = ""): Promise<string | null> {
  if (!host) return null;
  let prompt = message;
  for (;;) {
    const value = await host.app.promptDialog(prompt, current);
    if (value === null) return null;
    const name = value.trim();
    if (name) return name;
    prompt = `${message} (a tab name can't be empty)`;
  }
}

export async function createTab(side: Side): Promise<void> {
  if (!host) return;
  const title = await askName("New tab name");
  if (title === null) return;
  const icon = await host.app.pickIcon({ title: `Icon for ${title}` });
  if (icon === null) return;
  const record: TabRecord = { id: newTabId(), title, icon, side };
  save([...currentTabs(), record]);
  handles.get(record.id)?.reveal();
}

export async function renameTab(id: string): Promise<void> {
  if (!host) return;
  const tab = currentTabs().find((t) => t.id === id);
  if (!tab) return;
  const title = await askName("Rename tab", tab.title);
  if (title === null || title === tab.title) return;
  save(currentTabs().map((t) => (t.id === id ? { ...t, title } : t)));
}

export async function changeIcon(id: string): Promise<void> {
  if (!host) return;
  const tab = currentTabs().find((t) => t.id === id);
  if (!tab) return;
  const icon = await host.app.pickIcon({ title: `Icon for ${tab.title}`, current: tab.icon });
  if (icon === null || icon === tab.icon) return;
  save(currentTabs().map((t) => (t.id === id ? { ...t, icon } : t)));
}

export async function deleteTab(id: string): Promise<void> {
  if (!host) return;
  const tab = currentTabs().find((t) => t.id === id);
  if (!tab) return;
  const ok = await host.app.confirmDialog(
    `Delete the tab "${tab.title}"? Any panes in it go back to where they were before you moved them.`,
    "Delete Tab",
  );
  if (!ok) return;
  // Removed before the setting is written, so syncTabs doesn't see a
  // handle without a record and remove it a second time.
  const handle = handles.get(id);
  handles.delete(id);
  handle?.remove();
  save(currentTabs().filter((t) => t.id !== id));
}

// For the palette commands, which have no tab to start from.
export async function chooseTab(title: string): Promise<string | null> {
  if (!host) return null;
  const tabs = currentTabs();
  if (tabs.length === 0) {
    await host.app.confirmDialog("You have no custom tabs yet. Create one with Sidebar: New Tab.", "OK");
    return null;
  }
  return host.app.pickItem({
    title,
    items: tabs.map((t) => ({ id: t.id, label: t.title, icon: t.icon })),
    placeholder: "Type to filter tabs",
  });
}
