// The tab list in this extension's Settings section: every custom tab with
// its icon and name, and the same actions the tab strip menu offers. On a
// host without sidebar tab support it only explains that.
import { useEffect, useState } from "react";
import { changeIcon, createTab, deleteTab, listTabs, renameTab, tabsSettingReadable } from "./actions";
import Icon from "./Icon";
import type { SettingsApi, TabRecord } from "./store";

let settingsApi: SettingsApi | null = null;
let supported = false;

export function configureSettingsPanel(settings: SettingsApi, hostSupportsTabs: boolean): void {
  settingsApi = settings;
  supported = hostSupportsTabs;
}

export default function SettingsPanel() {
  const [tabs, setTabs] = useState<TabRecord[]>(() => (supported ? listTabs() : []));
  const [readable, setReadable] = useState(() => !supported || tabsSettingReadable());

  useEffect(() => {
    if (!supported || !settingsApi) return;
    const refresh = () => {
      setTabs(listTabs());
      setReadable(tabsSettingReadable());
    };
    refresh();
    return settingsApi.onDidChange(refresh);
  }, []);

  if (!supported) {
    return (
      <div className="custom-tabs-settings">
        <div className="settings-hint">
          Custom Sidebar Tabs needs a newer perch with sidebar tab support. Update perch, then reload
          the page.
        </div>
      </div>
    );
  }

  return (
    <div className="custom-tabs-settings">
      {!readable && (
        <div className="settings-hint custom-tabs-warning">
          The JSON above isn&apos;t a valid tab list, so your tabs are kept as they were. Fix it, or clear it and use
          the list below.
        </div>
      )}
      <div className="custom-tabs-list" role="list">
        {tabs.map((tab) => (
          <div className="custom-tabs-row" role="listitem" key={tab.id}>
            <Icon name={tab.icon} className="custom-tabs-icon" />
            <span className="custom-tabs-title">{tab.title}</span>
            <div className="custom-tabs-actions">
              <button type="button" className="dialog-button secondary" onClick={() => void renameTab(tab.id)}>
                Rename…
              </button>
              <button type="button" className="dialog-button secondary" onClick={() => void changeIcon(tab.id)}>
                Change Icon…
              </button>
              <button type="button" className="dialog-button secondary" onClick={() => void deleteTab(tab.id)}>
                Delete…
              </button>
            </div>
          </div>
        ))}
        {tabs.length === 0 && <div className="settings-hint">No custom tabs yet.</div>}
      </div>
      <div>
        <button type="button" className="dialog-button primary" onClick={() => void createTab("left")}>
          Add Tab
        </button>
      </div>
      <div className="settings-hint">
        New tabs are added to the left sidebar. Drag a pane header onto a tab&apos;s icon to move the pane into it,
        and drag the tab itself to reorder it or move it to the other sidebar.
      </div>
    </div>
  );
}
