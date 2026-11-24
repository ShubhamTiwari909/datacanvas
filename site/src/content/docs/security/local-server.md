---
title: Protecting the local server
description: How the Host check, Origin check, per-run session token, Content-Security-Policy and the separate door for Claude keep websites and other programs from using the DataCanvas server.
---

A web page you visit can try to reach programs listening on `127.0.0.1`. DataCanvas defends against that in
layers, all implemented in one pure module, `apps/web/lib/security/request-guard.ts`, which runs in two
places so that a mistake in one cannot silently open the API. Since 1.10.0 every page also carries a
Content-Security-Policy with a nonce, and since 1.11.0 there is a second, separate door for Claude (`/mcp`)
with its own token; both are described below.

## Listening address

DataCanvas listens on `127.0.0.1` only. The one exception is a **container** (1.11.0): `--host 0.0.0.0` is
accepted only when `DATACANVAS_ALLOW_ANY_INTERFACE=1` is set, which the Docker image does and a normal
computer does not. The rules below still apply, so a request through a LAN address, the container's own
address or a published port that differs from the container's is refused with 403 (all tested); publish the
port to `127.0.0.1` of the host only.

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

## The Content-Security-Policy of a page (1.10.0)

`apps/web/proxy.ts` makes a **nonce for each page request** (128 random bits, base64, never reused) and
sends a policy built by `apps/web/lib/security/csp.ts`. The request carries the policy too, because the
framework reads the nonce from it to put on its own scripts, and the layout reads an `x-nonce` header to put
it on the one inline script of ours (the one that sets the theme before the first paint). JSON answers of
`/api/*` get no page policy: there is no page or script to govern.

| Directive                                | Value                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `default-src`                            | `'none'`                                                                                                     |
| `script-src`                             | `'self'`, the request's `'nonce-…'`, `'strict-dynamic'` (and `'unsafe-eval'` in the development server only) |
| `style-src`                              | `'self'` and `'unsafe-inline'`                                                                               |
| `img-src`                                | `'self'` and `data:`                                                                                         |
| `font-src`, `worker-src`, `manifest-src` | `'self'`                                                                                                     |
| `connect-src`                            | `'self'` (the page may talk only to its own server)                                                          |
| `object-src`, `base-uri`                 | `'none'`                                                                                                     |
| `form-action`                            | `'self'`                                                                                                     |
| `frame-ancestors`                        | `'none'`                                                                                                     |

What this means in practice: a script runs only when it carries the nonce; **nothing runs from inline text,
an inline handler or `eval`** (outside development); the page connects only to its own server; no other
site can frame it. So text that ends up in a page (a table name, a value) cannot run as a script even if a
component forgot to escape it.

Residual risks, stated in `SECURITY.md`:

- **Styles keep `'unsafe-inline'`.** The canvas and the menus set `style` attributes, which a nonce cannot
  cover. No code runs from a style, so this is a smaller hole than scripts.
- **`'strict-dynamic'` trusts a script that already runs** to add scripts: markup that the parser reads
  cannot run, but a script that is already running is trusted.

The project's end-to-end suite runs with a listener that fails any test whose page breaks the policy (it
found exactly one violation, from a library probing for `eval`, now switched off in the browser).

## The door for Claude: `/mcp` (1.11.0)

`POST /mcp` is for **programs** (the `datacanvas mcp` bridge, an MCP client), not browsers, so it has a
**guard and a token of its own**, `evaluateMcpRequest` in the same `request-guard.ts`. It runs in the
front door and again in the route, like the cookie guard. In order:

1. **No token configured: the route does not exist (404).** The CLI passes the token in
   `DATACANVAS_MCP_TOKEN`; a value equal to the session token is treated as no token.
2. **While no connection is shared, the route does not exist either (404)**, checked **before the body is
   read**, so a program that finds the port and has the token learns nothing.
3. The **Host** check, as everywhere (DNS rebinding).
4. A request that carries an **`Origin`** or a **`Sec-Fetch-Site`** header is from a browser and is refused
   (403), so a web page cannot call `/mcp` even if it learned the token. (`Sec-Fetch-Mode` is not looked at:
   Node's own `fetch`, which the bridge uses, sends `cors` there.)
5. **`Authorization: Bearer <token>`**, compared in constant time.

The **MCP token** is 32 random bytes (256 bits, base64url), made by the CLI for each run. It is a **different secret** from the session token: it is accepted on `/mcp` and nowhere else.
The cookie guard never reads an `Authorization` header, so the token is **no credential for the app**
(an end-to-end test sends it to `/api/connections` and is refused), and the session token is refused on
`/mcp`. No CORS headers are sent. Only `POST` exists; `GET` and `DELETE` answer 405. The body is JSON, at
most **256 KB**, and nothing of it is logged. Each refusal is a fixed sentence that repeats nothing of the
request.

The token is written, with the process id and the port, to **`mcp.json`** in the data folder (mode `0600`,
deleted on a clean shutdown) so the bridge can find it. See
[Command-line and packaging](/architecture/cli-and-packaging/) and [MCP server](/architecture/mcp/).

**What this door cannot do:** share a connection, raise its level, approve or deny a call, or pause. Those
are `/api` routes behind the browser's cookie. See [Letting Claude read a connection](/security/risky-features/#letting-claude-read-a-connection-1110).

## Request parsing

`parseJsonBody` runs checks in a fixed order: `Content-Type: application/json` (415), body size (413,
streamed so a false `Content-Length` cannot bypass it), valid JSON (400 `invalid_json`), then a strict Zod
schema (400 `validation_error` with `issues: [{ path, message }]`). The default limit is 64 KB; routes that
legitimately take more (the SQL text, a write preview, an import) set their own and a framework proxy body
buffer of 36 MB is configured so a larger body is not cut short.

---

**Sources:** [`apps/web/proxy.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/proxy.ts),
[`apps/web/lib/security/request-guard.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/security/request-guard.ts),
[`apps/web/lib/security/csp.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/security/csp.ts),
[`apps/web/app/mcp/route.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/app/mcp/route.ts),
[`apps/web/app/layout.tsx`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/app/layout.tsx),
[`packages/cli/src/mcp-file.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/cli/src/mcp-file.ts),
[`SECURITY.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/SECURITY.md) ("How the local server is protected", items 7 and 8),
[`docs/threat-model.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/threat-model.md) (sections 12 and 13),
[`apps/web/lib/server/parse-request.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/parse-request.ts),
[`apps/web/next.config.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/next.config.ts),
[`packages/cli/src/web-server.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/cli/src/web-server.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/architecture.md) (Phases 3 and 10).
The "framework telemetry" and `DATACANVAS_SESSION_TOKEN` details come from the CLI and `docs/architecture.md`; the
exact per-route body limits were not individually verified.
