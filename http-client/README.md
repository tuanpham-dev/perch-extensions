# HTTP Client

Send HTTP requests from `.http` files and see the responses next to them.

## Request files

`.http` and `.rest` files use the format VS Code's REST Client and JetBrains' HTTP client read, so the same file works there too:

```http
@base = http://localhost:3000

# @name listProjects
GET {{base}}/api/sessions
Authorization: Bearer {{token}}

###
POST {{base}}/api/sessions
Content-Type: application/json

{ "cwd": "/home/me/shop" }
```

- `###` separates requests; `# @name` names one.
- A request is a `METHOD URL` line (GET when the method is left out), then headers, a blank line, and the body. `#` and `//` lines are comments above the request and among its headers; in the body they're sent as written, so a shell script or a YAML file with comments goes out whole.
- A body of just `< ./file.json` sends that file, relative to the `.http` file; `<@ ./file.json` fills the file's `{{variables}}` first.
- `# @no-redirect` above a request returns a 3xx response as it is (with its `Location`) instead of following it.
- `@name = value` sets a file variable. `{{name}}` is filled from the file's variables, then the selected environment, plus these system variables:
  - `{{$guid}}`, `{{$timestamp}}`, `{{$randomInt min max}}`
  - `{{$datetime iso8601}}`, `{{$datetime rfc1123}}` or `{{$datetime "YYYY-MM-DD HH:mm"}}` (Day.js-style tokens), in UTC, with an optional offset such as `{{$datetime iso8601 -1 d}}` (units `y M w d h m s ms`). `{{$localDatetime …}}` is the same in local time.
  - `{{$dotenv NAME}}`, from the nearest `.env` beside the file or in a folder above it.
  - `{{$processEnv NAME}}`, from the Perch server's environment.
- **Chaining:** `{{login.response.body.$.token}}` reads a field of the last response to the request named `login` in the same file (a small JSONPath: `.key`, `[0]`, `['key']`; `*` is the whole body), and `{{login.response.headers.X-Token}}` one of its headers; `request` instead of `response` reads what was sent. A request that reads from one that hasn't been sent yet sends it first.
- Environments come from `http-client.env.json` beside the file or in a folder above it (`{ "local": { "token": "…" }, "staging": { … }, "$shared": { … } }`). `http-client.private.env.json` overrides it value by value: put secrets there, and add it to your `.gitignore`. An env file that isn't valid JSON is reported above the requests, with the parser's message.

Open a file with **Preview** (the FILES hover icon, or the right-click menu); a plain click still opens it in your editor. Each request gets a **Send** button, and **Ctrl+Enter** (Cmd+Enter) sends the selected one. A variable the selected environment can't fill is underlined, and the request isn't sent.

## Responses

Status, time and size, then the body as a collapsible JSON tree (or raw), text, an image, or HTML source, and a Headers tab. A body over 10 MB shows its first 10 MB; **Save Response…** writes the whole body to a file. Requests time out after 30 seconds (Settings → HTTP Client), and a request in flight can be cancelled. A cancelled or timed-out download, or one whose tab was closed, stops at once and leaves no partial file on the server.

**Copy as curl** copies the selected request, with its variables filled in. **History** keeps the last 50 responses for each file (bodies up to 1 MB), privately on the Perch server in Perch's extension storage, and reopens any of them. Its search box filters by method, URL or status, and **Clear** deletes that file's history. Uninstalling HTTP Client keeps it; **Settings → Extensions → Stored data** deletes it.

## Scratch requests

**HTTP: New Request** in the command palette opens a request you fill in by hand: method, URL, headers and body. Paste a curl command (such as a browser's "Copy as cURL") into the URL field to fill everything in. Enter in the URL field, or Ctrl+Enter anywhere, sends it. **Save…** adds it to a `.http` file, `.perch/requests.http` in the project by default.

In the PORTS view, right-click a listening port and choose **Open in HTTP Client** for a request to `http://localhost:<port>/`.

## Where requests come from

The Perch server sends them, not your browser. So `localhost` is the machine your dev servers run on, even when you're on a phone. There's no allowlist of hosts: anyone who can use this extension already has a shell on that machine.

Needs Perch 0.9 or newer. Version 1.1 starts with an empty history: the `http-client/history.json` file 1.0 kept under Perch's config folder isn't carried over, and is left as it was.
