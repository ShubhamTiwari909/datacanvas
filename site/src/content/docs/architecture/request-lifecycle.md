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

## Before the handler: the front door and the page policy

Every request first meets `apps/web/proxy.ts`, which runs the same guard as `handleRoute` will repeat
(Host, Origin and `Sec-Fetch-Site`, session cookie). What happens next depends on the path:

- **`/api/*`**: the request goes on as it is. A JSON answer has no page or script for a policy to govern.
- **A page** (since 1.10.0): the proxy makes a **nonce for this request**, builds a
  **Content-Security-Policy** with it (`lib/security/csp.ts`) and puts it on the response **and on the
  request** (as `Content-Security-Policy`, so the framework can read the nonce and put it on its own
  scripts) plus an `x-nonce` request header that `app/layout.tsx` reads for its one inline script. The
  pages are therefore rendered for each request. See
  [Protecting the local server](/security/local-server/#the-content-security-policy-of-a-page-1100).
- **`/mcp`** (since 1.11.0): a different guard (`evaluateMcpRequest`: its own token, Host check, no `Origin`
  or `Sec-Fetch-Site`), no cookie and no page policy. See [below](#a-call-from-claude-mcp) and the
  [MCP server](/architecture/mcp/).

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

## A call from Claude (`/mcp`)

```text
Claude app ─▶ datacanvas mcp (stdio, reads mcp.json per message) ─▶ POST /mcp, Authorization: Bearer <MCP token>
  1. proxy.ts: pathname === "/mcp" → evaluateMcpRequest (404 no token · 403 Host · 403 Origin/Sec-Fetch-Site · 401 token)
  2. app/mcp/route.ts: the same guard again; 404 while mcp.anyShared() is false (the body is not read)
  3. parseJsonBody(request, z.unknown(), 256 KB)
  4. McpService.handle → packages/mcp: initialize | ping | tools/list | tools/call
  5. tools/call → track(): record in the activity list → paused? → rate limit (30 a minute)
        → data tool at the data level with approval on: wait for the person's Approve (2 minutes)
        → the tool: structure via ConnectionRegistry.use(adapter), or SqlService.run / ConnectionService.getRows
  6. one JSON-RPC answer (tool failures are results with isError; ≤ 200,000 characters)
```

The person's answers travel the other way, as ordinary cookie-guarded `/api/claude/*` calls from the
browser (the share dialog, the approval prompt, Pause), which the activity store **polls every 1.5 seconds
only while something is shared**.

## Composition root and singletons

`apps/web/lib/server/context.ts` builds the long-lived objects once and stores them on `globalThis` (under
`Symbol.for("datacanvas.server-context")`) so Next.js hot reload does not orphan open connections: the
adapter registry (with `postgresql` registered), the connection registry (with an idle sweeper), profile,
workspace and snapshot storage and services, the SQL service, the write service and, since 1.11.0, the
**`McpService`** (what is shared and how, the activity list, the pause). In production it simply means one
instance per process.

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

**Sources:** [`apps/web/proxy.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/proxy.ts),
[`apps/web/lib/security/csp.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/security/csp.ts),
[`apps/web/app/mcp/route.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/app/mcp/route.ts),
[`apps/web/lib/server/context.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/context.ts),
[`apps/web/lib/server/error-response.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/error-response.ts),
[`apps/web/lib/server/connection-service.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/connection-service.ts),
[`apps/web/lib/api-client.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/api-client.ts),
[`apps/web/app/api/connections/[id]/run/route.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/app/api/connections/%5Bid%5D/run/route.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/architecture.md) (Phases 2, 5, 6).
The handler snippet is a simplified illustration, not a verbatim copy.
