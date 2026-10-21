// Save for the views that edit a shared model (the editor tab and the merge
// view): asks first when the file changed on disk since it was loaded, then
// writes it back in the encoding it was read in.
import { checkDiskConflict } from "./diskConflict";
import { fetchFileText, saveFileText, type FileText } from "./fileApi";
import { hostPickItem } from "./host";
import { markSaved, reloadFromDisk, type FileEntry } from "./models";

/** Resolves true when the editor's text is now on disk. */
export async function saveEntry(entry: FileEntry): Promise<boolean> {
  if (!entry.model) return false;
  let disk: FileText | null = null;
  const choice = await checkDiskConflict({
    name: entry.filePath.slice(entry.filePath.lastIndexOf("/") + 1),
    loaded: entry.savedText,
    readDisk: async () => (disk = await fetchFileText(entry.filePath)).text,
    pick: hostPickItem ?? undefined,
  });
  if (choice === "cancel") return false;
  if (choice === "reload") {
    if (disk) reloadFromDisk(entry, disk);
    return false;
  }
  // Read after the question, so nothing typed while it was open is left out.
  if (!entry.model) return false;
  const content = entry.model.getValue();
  await saveFileText(entry.filePath, content, entry.encoding);
  // Shared baseline: a save in either split pane clears the dirty flag in
  // both, since they are the same document.
  markSaved(entry, content);
  return true;
}
