---
title: Request lifecycle
description: Follow "Connect" and "open a table" from the browser to PostgreSQL and back, and see where validation, guards and errors apply.
---

## Anatomy of a route handler

A route handler is a `route.ts` file under `apps/web/app/api/**` that exports a function named after an
HTTP method. Every handler declares `runtime = "nodejs"` and `dynamic = "force-dynamic"` (never cached or
prerendered), runs inside `handleRoute(request, work)`, and is about 15 lines: validate, call a service
method, return JSON.

```ts
// Shape of a typical handler (simplified from apps/web/app/api/connections/[id]/run/route.ts)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: RouteParams<{ id: string }>) {
  return handleRoute(request, async () => {
    const parsed = await parseJsonBody(request, schema);
    if (!parsed.ok) return parsed.response; // complete error response
    const { id } = await params;
    // … call the service with parsed.data (typed AND verified)
    return jsonResponse({ result }); // no-store
  });
}
```

`app/api/[...path]/route.ts` is a catch-all that returns the standard JSON error for unknown `/api/*`
URLs, so clients never receive an HTML 404 from an API URL. More specific routes always win.

## Connect

```text
ConnectionForm (browser)
  1. validate with the shared Zod schema               → field errors shown instantly
  2. createConnection(input)   features/connections/api.ts
  3. apiRequest("POST /api/connections")               lib/api-client.ts (never throws)
        │   HTTP, JSON body (contains the password, over loopback only)
        ▼
app/api/connections/route.ts  POST
  4. parseJsonBody(request, postgresConnectionInputSchema)   → 415 / 413 / 400 or typed data
  5. getServerContext().connections.createConnection(data)
        ▼
ConnectionService.createConnection
  6. resolvePostgresConnection(data)                   one normalised shape, SSL mode decided
  7. adapters.create("postgresql", resolved)           AdapterRegistry → createPostgresAdapter
  8. adapter.connect()                                 pool + SELECT 1 in a READ ONLY transaction
        │   failure: DatabaseError(code) → nothing stored
        ▼
ConnectionRegistry.add(summary, adapter)               opaque id; password stays INSIDE the adapter
        ▼
201 { connection: { id, name, host, …, hasPassword } }       (no password)
```

Every failure from step 4 to 8 is converted by `handleRoute` into `{ error: { code, message } }` with a
suitable HTTP status; the form shows the message. See [Error codes](/reference/error-codes/).

## A read through the adapter

```text
adapter.getColumns("public", "orders")
  → read(): is there a pool?                      no → DatabaseError not_connected
  → pool.connect() → BEGIN READ ONLY → set_config('statement_timeout', …, local)
  → assertRelationExists()                        no → DatabaseError not_found
  → COLUMNS_SQL with $1 = "public", $2 = "orders" (bound parameters, never string-built)
  → map rows to ColumnInfo[] → COMMIT → release the connection to the pool
  → any error on the way: ROLLBACK, then mapPgError() → DatabaseError
```

## Composition root and singletons

`apps/web/lib/server/context.ts` builds the long-lived objects once and stores them on `globalThis` (under
`Symbol.for("datacanvas.server-context")`) so Next.js hot reload does not orphan open connections: the
adapter registry (with `postgresql` registered), the connection registry (with an idle sweeper), profile,
workspace and snapshot storage and services, the SQL service and the write service. In production it
simply means one instance per process.

## Error handling

`handleRoute` (in `error-response.ts`) turns any thrown value into the standard error response. A
`DatabaseError` or `ServiceError` keeps its safe code and message; anything else becomes the generic
`unexpected` response. It logs only error **names and codes**, never messages. Driver errors never leave
the adapter package: `mapPgError` maps them to codes with fixed messages and keeps the original only as
`cause`, which `toJSON` does not serialise.

## The client side

- `lib/api-client.ts`: `apiRequest(path, schema, options)` never throws; it returns verified data or
  `{ code, message, issues }`, and verifies every response with the shared schemas.
- `lib/use-async-data.ts`: loading / error / success state, reload, and ignoring stale responses.
- Zustand stores hold UI state (see [Web app](/architecture/web-app/)). The server stays the source of
  truth for connections: refreshing the page asks `GET /api/connections` and the server still holds them.

---

**Sources:** [`apps/web/lib/server/context.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/context.ts),
[`apps/web/lib/server/error-response.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/error-response.ts),
[`apps/web/lib/server/connection-service.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/connection-service.ts),
[`apps/web/lib/api-client.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/api-client.ts),
[`apps/web/app/api/connections/[id]/run/route.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/app/api/connections/%5Bid%5D/run/route.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md) (Phases 2, 5, 6).
The handler snippet is a simplified illustration, not a verbatim copy.
