// Remote-to-local clipboard: text copied on the desktop is written to the
// browser clipboard when the document has focus; otherwise it waits for the
// toolbar button, whose click handler may write it.

export interface ClipboardBridge {
  /** Text the desktop just copied. */
  remoteText(text: string): Promise<void>;
  /** From a click handler: write the waiting text. True when it went through. */
  copyPending(): Promise<boolean>;
  readonly pending: string | null;
}

export function createClipboardBridge(onPendingChange: (pending: boolean) => void): ClipboardBridge {
  let pending: string | null = null;

  const setPending = (text: string | null) => {
    const changed = (pending === null) !== (text === null);
    pending = text;
    if (changed) onPendingChange(text !== null);
  };

  const write = async (text: string): Promise<boolean> => {
    if (!navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };

  return {
    get pending() {
      return pending;
    },
    async remoteText(text: string) {
      if (document.hasFocus() && (await write(text))) {
        setPending(null);
        return;
      }
      setPending(text);
    },
    async copyPending() {
      if (pending === null) return false;
      if (await write(pending)) {
        setPending(null);
        return true;
      }
      return false;
    },
  };
}
