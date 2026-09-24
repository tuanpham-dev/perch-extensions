// Talking to this extension's own server hook.
//
// Its own module because three places need it now - the panel, the batch
// views, and the settings panel's token field - and a shared helper importing
// the panel back would be a cycle. activate() hands the host's serverFetch in
// once; everything else just calls apiGet/apiPost.
//
// An error body's `error` field is what the server puts a refusal in, so it
// is what the thrown Error carries: the panel shows that message verbatim,
// because the server wrote it for the user rather than for a log.

let fetcher: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;

export function setApiFetcher(fn: ((path: string, init?: RequestInit) => Promise<Response>) | null): void {
  fetcher = fn;
}

export async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status message
    }
    const error = new Error(message) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export function apiGet<T>(path: string): Promise<T> {
  if (!fetcher) return Promise.reject(new Error("extension not activated"));
  return fetcher(path).then((res) => readJson<T>(res));
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  if (!fetcher) return Promise.reject(new Error("extension not activated"));
  return fetcher(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) => readJson<T>(res));
}
