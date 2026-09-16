// Custom Sidebar Tabs: the user's own sidebar tabs, each a container they
// fill by moving panes into it. The host does the tab mechanics
// (ctx.registerSidebarTab); this extension keeps the list, and offers
// create / rename / change icon / delete from the tab strip's right-click
// menu, the command palette, and its Settings section.
import {
  changeIcon,
  chooseTab,
  createTab,
  deleteTab,
  init,
  recordForTabId,
  renameTab,
  syncTabs,
  type Host,
} from "./actions";
import { injectStylesheet } from "./injectStylesheet";
import SettingsPanel, { configureSettingsPanel } from "./SettingsPanel";
import type { SettingsApi } from "./store";
import "./style.css";

type Side = "left" | "right";

interface SidebarTabMenuContext {
  tabId: string | null;
  side: Side;
}

interface ExtensionContext extends Partial<Pick<Host, "registerSidebarTab">> {
  settings: SettingsApi;
  app: Host["app"];
  assetUrl(relPath: string): string;
  registerCommand(cmd: { id: string; label: string; run: () => void }): void;
  registerSettingsComponent(entry: { id: string; component: () => ReturnType<typeof SettingsPanel> }): void;
  registerSidebarTabMenuItem?(item: {
    id: string;
    label: string;
    order?: number;
    isVisible: (ctx: SidebarTabMenuContext) => boolean;
    onClick: (ctx: SidebarTabMenuContext) => void;
  }): void;
}

let removeStylesheet: (() => void) | null = null;
let removeSettingsListener: (() => void) | null = null;

export function activate(ctx: ExtensionContext): void {
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  const supported =
    typeof ctx.registerSidebarTab === "function" && typeof ctx.registerSidebarTabMenuItem === "function";
  configureSettingsPanel(ctx.settings, supported);
  ctx.registerSettingsComponent({ id: "tabs", component: SettingsPanel });
  if (!supported) return;

  init({ settings: ctx.settings, registerSidebarTab: ctx.registerSidebarTab!, app: ctx.app });
  syncTabs();
  removeSettingsListener = ctx.settings.onDidChange(syncTabs);

  const ours = ({ tabId }: SidebarTabMenuContext) => recordForTabId(tabId) !== undefined;
  const run = (action: (id: string) => Promise<void>) => ({ tabId }: SidebarTabMenuContext) => {
    const record = recordForTabId(tabId);
    if (record) void action(record.id);
  };
  const addMenuItem = ctx.registerSidebarTabMenuItem!;
  addMenuItem({ id: "new-tab", label: "New Tab…", order: 0, isVisible: () => true, onClick: ({ side }) => void createTab(side) });
  addMenuItem({ id: "rename-tab", label: "Rename…", order: 1, isVisible: ours, onClick: run(renameTab) });
  addMenuItem({ id: "change-icon", label: "Change Icon…", order: 2, isVisible: ours, onClick: run(changeIcon) });
  addMenuItem({ id: "delete-tab", label: "Delete Tab…", order: 3, isVisible: ours, onClick: run(deleteTab) });

  const withChosenTab = (title: string, action: (id: string) => Promise<void>) => () =>
    void chooseTab(title).then((id) => (id ? action(id) : undefined));
  ctx.registerCommand({ id: "newTab", label: "Sidebar: New Tab…", run: () => void createTab("left") });
  ctx.registerCommand({ id: "renameTab", label: "Sidebar: Rename Tab…", run: withChosenTab("Rename which tab?", renameTab) });
  ctx.registerCommand({
    id: "changeTabIcon",
    label: "Sidebar: Change Tab Icon…",
    run: withChosenTab("Change the icon of which tab?", changeIcon),
  });
  ctx.registerCommand({ id: "deleteTab", label: "Sidebar: Delete Tab…", run: withChosenTab("Delete which tab?", deleteTab) });
}

// The host unregisters the tabs on its own and keeps where their panes were,
// so they come back with the extension. Nothing here may remove them.
export function deactivate(): void {
  removeSettingsListener?.();
  removeSettingsListener = null;
  init(null);
  removeStylesheet?.();
  removeStylesheet = null;
}
