# Security and privacy

DataCanvas is a local tool: it runs on your computer, talks to your database from your computer, and sends nothing anywhere else. This page says exactly what that means, and what it does not.

> DataCanvas has not had an independent security review. Nothing here is a guarantee that it is "completely secure". Please read the limits at the end.

## What stays on your machine

| Thing                         | Where it lives                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Database password             | In memory of the running server only. Never written to disk, never returned by the API, never logged.                  |
| Host, port, database, user    | In `~/.datacanvas/connections.json` only if you choose **Save connection**. Not the password.                          |
| Canvas layouts                | `~/.datacanvas/workspaces/` (table names and positions). Files are owner-only (mode 0600).                             |
| Session token (while running) | In the server's memory and in `~/.datacanvas/run.json` (owner-only) so a second launch can reopen it. Deleted on exit. |
| What leaves the machine       | Nothing. No account, no cloud, no analytics. Telemetry of the web framework is switched off at start-up.               |

Set `DATACANVAS_HOME` to use a different folder.

## What DataCanvas reads from your database

Only **metadata**: schema, table and column names, types, keys, indexes, constraints, comments and row-count estimates. It never reads table rows and has no way to run your own SQL. Every metadata query runs in a read-only transaction.

## How the local server is protected

A web page you visit can try to reach programs listening on `127.0.0.1`. DataCanvas defends against that in layers:

1. It listens on `127.0.0.1` only, never on your network.
2. **Host check** (blocks "DNS rebinding"): only `127.0.0.1:<port>` and `localhost:<port>` are accepted.
3. **Origin check**: state-changing requests from another web page are refused. The browser's `Sec-Fetch-Site` hint must say same-origin.
4. **Session token**: every start creates a new random secret. The link printed by `datacanvas` carries it once; the app swaps it for an `HttpOnly`, `SameSite=Strict` cookie and removes it from the address bar. Requests without it are refused. Treat the printed link like a password while DataCanvas runs.
5. The checks run in the front door (`proxy.ts`) **and** again inside every API route.
6. No CORS headers are ever sent, so other sites cannot read responses. Responses forbid framing and referrers.

## What to do for your database

- Use a **read-only database user** with the least access that is useful.
- Use **TLS with certificate verification** when the database is not on your own machine.
- DataCanvas sets connection and statement timeouts and limits the size of everything it reads.

## Before you export a diagram

A PNG, SVG or workspace file shows **table and column names**. That can reveal how a system works. It contains no row data and is created on your machine, but share it only with people who should see your schema.

## Known limits

- Another program running as **your user** can read the process list and so the token. DataCanvas does not defend against an attacker who already has your account.
- The token travels over plain `http` on loopback. Other users on a shared machine cannot normally see loopback traffic, but this is not hardened against a hostile administrator.
- Cookies are not isolated by port; other web apps on `127.0.0.1` receive the cookie. The Origin and `Sec-Fetch-Site` checks stop them from using it from a browser.
- There is no full Content-Security-Policy yet (the framework inlines scripts; this needs nonces).
- Passwords live in memory, so they are present in a memory dump of the process.
- Two DataCanvas processes sharing one data folder are not coordinated.

The full reasoning is in [docs/threat-model.md](docs/threat-model.md).

## Reporting a problem

Please report vulnerabilities privately to the maintainers (a contact address will be added before the first public release) and do not open a public issue with exploit details.
