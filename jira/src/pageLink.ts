// Where a ticket's page is on an agent's dev server, as this browser can
// reach it. On the machine itself that is the port directly; from anywhere
// else it goes through Perch's port proxy, the same way the Ports panel
// opens a port: a subdomain per port when a proxy domain is set, the
// app's own /proxy/<port>/ otherwise.

export interface BrowserPlace {
  protocol: string;
  hostname: string;
  origin: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// "/products/socks?variant=2" stays as it is; "pages/about" gains its slash;
// a full URL keeps only its path, query and hash, since the server is the
// port's, not the one the URL names.
export function pagePath(page: string): string {
  const text = page.trim();
  if (!text) return "/";
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return "/";
    }
  }
  return text.startsWith("/") ? text : `/${text}`;
}

export function portPageUrl(port: number, page: string, place: BrowserPlace, proxyDomain: string | null): string {
  const path = pagePath(page);
  if (LOCAL_HOSTS.has(place.hostname)) return `http://${place.hostname.includes(":") ? "[::1]" : place.hostname}:${port}${path}`;
  if (proxyDomain) return `${place.protocol}//${port}.${proxyDomain}${path}`;
  return `${place.origin}/proxy/${port}${path}`;
}

// The QA agent's own preview URL (what it gave `qa-start --url`) on the
// ticket's page: its origin, the page's path, and its query kept where the
// page has none of its own.
export function previewPageUrl(previewUrl: string, page: string): string {
  let base: URL;
  try {
    base = new URL(previewUrl);
  } catch {
    return "";
  }
  const url = new URL(pagePath(page), base.origin);
  for (const [name, value] of base.searchParams) {
    if (!url.searchParams.has(name)) url.searchParams.set(name, value);
  }
  return url.toString();
}
