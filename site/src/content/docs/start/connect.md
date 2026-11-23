---
title: Connect a database
description: Connect with a connection string or separate fields, choose encryption, and understand what is remembered.
---

Choose **Connect PostgreSQL**, then either paste a connection string:

```text
postgresql://user:password@host:5432/database
```

or switch to the fields form. **Test connection** checks the details and keeps nothing; **Connect**
opens the connection.

## Good practice

- **Use a read-only database user** with the least access that is useful. Unless you start DataCanvas
  with `--enable-writes`, it only reads (metadata, and rows if you switch that on). A read-only user
  turns that into a guarantee. DataCanvas warns beside the connection when your role can change data
  or create objects.
- For a database that is not on your own computer, use **Encrypted and verified** (TLS with
  certificate checking). The default `sslMode` for a remote host is the strictest, `verify-full`.
- The **password stays in memory**. After a restart you are asked for it again. Host, port, database
  and user can be remembered with **Save connection**.

## What the connection form accepts

The connection contract lives in `@datacanvas/shared-types` and is validated twice: in the browser for
fast feedback and again on the server, because anyone can call the API without the UI.

- Two entry modes share field rules: `string` (a connection string) and `fields`.
- Unknown keys are rejected, and types are **not** coerced (a port sent as the string `"5432"` is
  refused; the UI converts before sending).
- Defaults: port 5432, empty password, `sslMode` `verify-full`.
- The parser understands `sslmode` and, as libpq writes it, `host` and `port` in the query string, so
  `postgresql://user:pw@/db?host=10.1.2.3` works. Other query parameters (such as Prisma's `schema=`)
  are ignored on purpose.
- A host that is a **file path** (a Unix socket, for example Cloud SQL's `/cloudsql/...`) is refused
  with one fixed explanation. See [Cloud databases and TLS](/guides/cloud-databases/).
- No error message ever contains any part of what you typed, because the input holds the password.

## What happens when you press Connect

1. The form validates with the shared schema.
2. The browser sends `POST /api/connections` over loopback.
3. The server validates the body again, builds a PostgreSQL adapter and opens a pool with a
   `SELECT 1` inside a read-only transaction.
4. On success the server stores the adapter under an **opaque id** and returns a summary with
   `hasPassword: true/false` and **never the password**. On failure nothing is stored.

The full path is described in [Request lifecycle](/architecture/request-lifecycle/).

## Limits worth knowing

- At most **10 connections** at once (`connection_limit_reached` beyond that).
- A connection idle for **30 minutes** has its database sessions closed; the next request reconnects
  transparently. Only **Disconnect** (or stopping DataCanvas) discards the credentials.
- Connecting times out after **10 seconds**; each catalog query after **15 seconds**; the pool holds
  at most **3** connections.

## Optional switches on a connection

| Switch                                              | Default | What it adds                                                                                                                          |
| --------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Allow viewing table data**                        | off     | Rows in the Data section, the SQL tab, export, Validate and the migration pre-flight. See [Viewing table rows](/guides/data-viewer/). |
| **Writes** (only if started with `--enable-writes`) | locked  | Editing rows and designing tables, for local databases only. See [Editing rows and tables](/guides/editing/).                         |

---

**Sources:**
[`packages/shared-types/src/postgres-connection.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/shared-types/src/postgres-connection.ts),
[`apps/web/lib/server/connection-registry.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/connection-registry.ts),
[`packages/postgres-adapter/src/connection/config.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/postgres-adapter/src/connection/config.ts),
[`docs/getting-started.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/getting-started.md),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md) (Phases 3 and 6).
The 10-connection limit and 30-minute idle time are taken from `docs/architecture.md` and the registry's
default in `connection-registry.ts`.
