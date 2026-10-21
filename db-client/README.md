# DB Client

Browse and query your databases from Perch: SQLite, PostgreSQL, MySQL / MariaDB, Redis and MongoDB.

## Connections

The **DATABASES** section in the Explorer lists your connections. **+** adds one, from a connection URL (`postgres://user:password@host:5432/db`, `mysql://…`, `redis://…`, `mongodb://…`) or from separate fields. If the project's `.env` (or `.env.local`, `.env.development`) has a `DATABASE_URL`, `REDIS_URL` or `MONGODB_URI`, it's offered at the top of the form with the password hidden. A `.sqlite`, `.sqlite3` or `.db` file opens straight from its right-click menu in FILES: **Open in Database Client**.

Connections and query history are saved privately on the Perch server, in Perch's extension storage (`extension-data/perch.db-client` under Perch's config folder). Passwords go to Perch's secret store, and are never sent back to a browser. Uninstalling DB Client keeps them; **Settings → Extensions → Stored data** deletes them.

Needs Perch 0.9 or newer. Version 1.1 starts with no saved connections: those saved by 1.0 (in `db-client/connections.json` under Perch's config folder) aren't carried over, and that file is left as it was. Their passwords stay in Perch's secret store.

## Read-only by default

A new connection is **read-only**, and that's enforced on the server, not just in the page:

- **PostgreSQL, MySQL:** every query runs inside a read-only transaction that's rolled back afterwards, and statements that would end or loosen that transaction (`COMMIT`, `SET TRANSACTION`, `SET autocommit`, …) are refused.
- **SQLite:** the file is opened read-only.
- **Redis:** only read commands run (`GET`, `HGETALL`, `SCAN`, …).
- **MongoDB:** only `find`, and `aggregate` without `$out` or `$merge`.

To change data, click the **read-only** pill on a query tab (or **Make Writable…** in the connection's right-click menu) and confirm. A writable connection is marked **writable** in the tree and on its tabs.

## Querying

- **SQL:** click a table to run `SELECT * … LIMIT 100`, or **New Query** from a connection's right-click menu. `Ctrl+Enter` (`Cmd+Enter`) runs the selected text, or the whole query. Results show each column's type, NULL as NULL, and a row's full values when you click it. A script with several statements shows the last result and what the others changed; on a writable PostgreSQL connection it runs as one transaction unless it has its own `BEGIN`/`COMMIT`.
- **MongoDB:** a query bar for filter, projection and sort (Extended JSON, so `{"$oid": "…"}` works), or an aggregation pipeline; results as documents or a table.
- **Redis:** a key browser with a pattern filter and type-aware views of strings, hashes, lists, sets, sorted sets and streams, with each key's TTL (the list loads a page of keys at a time; **Load more** reads the next), plus a command console. Blocking commands such as `BLPOP`, `XREAD BLOCK` and `SUBSCRIBE` run on a connection of their own, until they return, the timeout or **Cancel**; `SUBSCRIBE` and `MONITOR` show what they heard.

Results stop at 1,000 rows and queries at 30 seconds (both in Settings → DB Client). Only that many rows are ever read from the database: the rest are never fetched. Each query tab has its own connection, so **Cancel** stops that tab's query on the database server and leaves other tabs running; a connection that drops reconnects on the next query. Results can be exported as CSV or JSON, and **History** (on SQL, MongoDB and Redis tabs) keeps each connection's last 100 queries, with a search box and **Clear**.

## Installing

The drivers are bundled into the extension (`dist/server.js`), so there's nothing else to install. SQLite uses the one built into Node, which needs Node 23.4 or newer.
