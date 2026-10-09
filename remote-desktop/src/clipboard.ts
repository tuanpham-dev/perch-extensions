// Remote-to-local clipboard: text or a PNG copied on the desktop is written
// to the browser clipboard when the document has focus; otherwise it waits
// for the toolbar button, whose click handler may write it.

export type ClipboardContent = { kind: "text"; text: string } | { kind: "image"; png: Uint8Array };

export interface ClipboardBridge {
  /** Text the desktop just copied. */
  remoteText(text: string): Promise<void>;
  /** A PNG the desktop just copied. */
  remoteImage(png: Uint8Array): Promise<void>;
  /** From a click handler: write the waiting content. True when it went through. */
  copyPending(): Promise<boolean>;
  readonly pending: ClipboardContent | null;
}

export function createClipboardBridge(onPendingChange: (pending: boolean) => void): ClipboardBridge {
  let pending: ClipboardContent | null = null;

  const setPending = (content: ClipboardContent | null) => {
    const changed = (pending === null) !== (content === null);
    pending = content;
    if (changed) onPendingChange(content !== null);
  };

  const write = async (content: ClipboardContent): Promise<boolean> => {
    try {
      if (content.kind === "text") {
        if (!navigator.clipboard?.writeText) return false;
        await navigator.clipboard.writeText(content.text);
        return true;
      }
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
      const blob = new Blob([content.png as BlobPart], { type: "image/png" });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return true;
    } catch {
      return false;
    }
  };

  const remote = async (content: ClipboardContent) => {
    if (document.hasFocus() && (await write(content))) {
      setPending(null);
      return;
    }
    setPending(content);
  };

  return {
    get pending() {
      return pending;
    },
    remoteText: (text) => remote({ kind: "text", text }),
    remoteImage: (png) => remote({ kind: "image", png }),
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
