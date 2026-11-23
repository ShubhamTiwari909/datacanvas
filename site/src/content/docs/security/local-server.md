---
title: Protecting the local server
description: How the Host check, Origin check, per-run session token and response headers keep websites and other programs from using the DataCanvas server.
---

A web page you visit can try to reach programs listening on `127.0.0.1`. DataCanvas defends against that in
layers, all implemented in one pure module, `apps/web/lib/security/request-guard.ts`, which runs in two
places so that a mistake in one cannot silently open the API.

## Two places, same rules

1. **`apps/web/proxy.ts`** (the Next.js 16 name for middleware) runs before every page and route. It also
   performs the one-time **token exchange**.
2. **`handleRoute(request, work)`** repeats the checks inside **every API route** (`/api/health` calls
   `guardRequest` directly). If the proxy were bypassed or misconfigured, no route could still run
   unguarded. `tests/security.test.ts` fails if a route forgets this.

## The rules, in order

1. **Host** must be `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding).
2. For `/api/*`, the browser's **`Sec-Fetch-Site`** must be `same-origin` or `none`.
3. State-changing requests that carry an **`Origin`** must come from our own origin.
4. The **session cookie** must match the per-run token (constant-time comparison).

`/api/health` is the only path without the token (the CLI polls it). In production, a missing token means
**refuse everything** (503), never "run open".

## The token

- The CLI creates a fresh **32-byte token** for every run and passes it to the server through the
  environment (`DATACANVAS_SESSION_TOKEN`).
- The first URL printed is `/?token=…`. If the token matches (and the Host check passes first, so a
  rebinding page cannot use this path to probe for it), the proxy sets an `HttpOnly`, `SameSite=Strict`
  cookie named `dc_session_<port>` and redirects to the same URL **without** the token, so the secret does
  not stay in the address bar, history or a `Referer` header.
- The cookie has no `Secure` flag because the app is served over plain `http` on loopback, where some
  browsers refuse a `Secure` cookie.
- Anyone holding the token can use the app, including switching on data viewing and, with writes on,
  changing a local database. **Treat the printed link like a password.**

## Response headers

`apps/web/next.config.ts` adds, to every response: `Content-Security-Policy: frame-ancestors 'none'`,
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Resource-Policy: same-origin` and `Cross-Origin-Opener-Policy: same-origin`. The framework's
`X-Powered-By` header is turned off. **No CORS headers are ever sent**, so other sites cannot read
responses.

A **full Content-Security-Policy** is not set yet: the framework inlines scripts, so it needs per-request
nonces. This is listed as a known limit.

## Request parsing

`parseJsonBody` runs checks in a fixed order: `Content-Type: application/json` (415), body size (413,
streamed so a false `Content-Length` cannot bypass it), valid JSON (400 `invalid_json`), then a strict Zod
schema (400 `validation_error` with `issues: [{ path, message }]`). The default limit is 64 KB; routes that
legitimately take more (the SQL text, a write preview, an import) set their own and a framework proxy body
buffer of 36 MB is configured so a larger body is not cut short.

---

**Sources:** [`apps/web/proxy.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/proxy.ts),
[`apps/web/lib/security/request-guard.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/security/request-guard.ts),
[`apps/web/lib/server/parse-request.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/parse-request.ts),
[`apps/web/next.config.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/next.config.ts),
[`packages/cli/src/web-server.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/cli/src/web-server.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md) (Phases 3 and 10).
The "framework telemetry" and `DATACANVAS_SESSION_TOKEN` details come from the CLI and `docs/architecture.md`; the
exact per-route body limits were not individually verified.
