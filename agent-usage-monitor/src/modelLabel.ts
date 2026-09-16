// A model id as it should read in the status bar: the name, without the
// vendor prefix the id carries or the release date stuck on the end.
// "claude-haiku-4-5-20251001" is the same model as "haiku-4-5" to anyone
// reading a 22px-tall bar, and the full id stays in the tooltip.
const VENDOR_PREFIXES = ["claude-", "anthropic/", "anthropic.", "openai/", "google/", "gpt-oss-"];
// A trailing release stamp: 20251001, 2025-10-01, or -latest.
const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/;

export function modelLabel(modelId: string | undefined | null): string {
  if (typeof modelId !== "string" || !modelId.trim()) return "";
  let name = modelId.trim();
  for (const prefix of VENDOR_PREFIXES) {
    if (name.toLowerCase().startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  name = name.replace(DATE_SUFFIX, "");
  // Never trim a name down to nothing, or to a bare date: an id made only of
  // a vendor and a stamp keeps whatever it started as.
  if (!name || /^(\d{8}|\d{4}-\d{2}-\d{2})$/.test(name)) return modelId.trim();
  return name;
}
