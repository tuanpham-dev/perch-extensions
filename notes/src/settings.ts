// This extension's settings, live: the corner chip's switch. (The status-bar
// item's switch is the host's own visibilitySetting.)
import { useSyncExternalStore } from "react";

export interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

let showChip = true;
const listeners = new Set<() => void>();

function read(api: SettingsApi) {
  const next = api.get("notes.showChip") !== false;
  if (next === showChip) return;
  showChip = next;
  for (const l of listeners) l();
}

export function initSettings(api: SettingsApi): () => void {
  read(api);
  return api.onDidChange(() => read(api));
}

export function useShowChip(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => showChip,
  );
}
