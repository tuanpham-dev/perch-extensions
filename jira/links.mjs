// The review links a ticket carries: GitHub pull requests and Shopify preview
// themes, found in its description and comments.
//
// Plain ESM beside server.js for the same reason as brief.mjs: the server adds
// `links` to every ticket detail, and the client reads the result rather than
// parsing comment text a second time. links.d.mts types it for the client.
//
// Newest first, because a ticket that iterates collects a link per round and
// the latest is nearly always the one to look at - the panel lets the user
// pick an older one when it is not.

const URL_PATTERN = /https?:\/\/[^\s<>()\[\]"'`]+/g;
// Markdown and chat punctuation that sticks to the end of a pasted link.
const TRAILING = /[.,;:!?*_~]+$/;

const PR_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const EDITOR_PATTERN = /^https:\/\/admin\.shopify\.com\/store\/([A-Za-z0-9_-]+)\/themes\/(\d+)\/editor(?:[/?#].*)?$/;

function clean(raw) {
  return raw.replace(TRAILING, "");
}

function parsePr(url) {
  const match = PR_PATTERN.exec(url);
  if (!match) return null;
  const [, owner, repo, number] = match;
  return {
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    owner,
    repo,
    number: Number(number),
  };
}

function parsePreview(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const editor = EDITOR_PATTERN.exec(url);
  if (editor) {
    const previewPath = parsed.searchParams.get("previewPath");
    return {
      kind: "editor",
      url,
      store: editor[1],
      themeId: editor[2],
      origin: "",
      path: previewPath && previewPath.startsWith("/") ? previewPath : "/",
    };
  }
  const themeId = parsed.searchParams.get("preview_theme_id");
  if (!themeId || !/^\d+$/.test(themeId)) return null;
  return {
    kind: "preview",
    url,
    store: "",
    themeId,
    origin: parsed.origin,
    path: parsed.pathname || "/",
  };
}

// `detail` is the ticket as issueDetail builds it: description and comments
// as markdown, each comment with its author and ISO creation time.
export function findTicketLinks(detail) {
  const sources = [];
  if (detail?.description) sources.push({ text: detail.description, author: null, at: detail.created ?? null });
  for (const comment of Array.isArray(detail?.comments) ? detail.comments : []) {
    if (comment?.body) sources.push({ text: comment.body, author: comment.author ?? null, at: comment.created ?? null });
  }

  const prs = new Map();
  const previews = new Map();
  for (const source of sources) {
    for (const match of source.text.matchAll(URL_PATTERN)) {
      const url = clean(match[0]);
      const pr = parsePr(url);
      if (pr) {
        prs.set(pr.url, { ...pr, author: source.author, at: source.at });
        continue;
      }
      const preview = parsePreview(url);
      if (preview) previews.set(preview.url, { ...preview, author: source.author, at: source.at });
    }
  }

  // Map insertion keeps the first sighting; re-setting a key moves nothing, so
  // order by time here instead. A description link (the ticket's creation
  // time) sorts before every comment, which is when it was written.
  const newestFirst = (a, b) => String(b.at ?? "").localeCompare(String(a.at ?? ""));
  return {
    prs: [...prs.values()].sort(newestFirst),
    previews: [...previews.values()].sort(newestFirst),
  };
}
