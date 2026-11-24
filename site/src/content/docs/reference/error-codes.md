---
title: Error codes
description: The stable error codes the API returns, with the HTTP status each maps to.
---

Every API failure has the same shape:

```json
{
  "error": {
    "code": "validation_error",
    "message": "…",
    "issues": [{ "path": "port", "message": "…" }]
  }
}
```

`code` is stable and machine-readable; `message` is a **safe, fixed sentence**. Neither ever contains a
secret, SQL, a connection string, a row value or a raw driver error. `issues` is present only for
`validation_error`. The response schema types `code` as a plain string on purpose, so an older UI can still
read a code a newer server invents.

HTTP statuses below are the database/service mapping in `apps/web/lib/server/error-response.ts`. Request-level
errors come from the request parser and the guard.

## Request and guard

| Code                     | Status                                              | Meaning                                                                |
| ------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------- |
| `validation_error`       | 400                                                 | The body did not match its schema; `issues` lists fields.              |
| `invalid_json`           | 400                                                 | The body is not valid JSON.                                            |
| `unsupported_media_type` | 415                                                 | `Content-Type` is not `application/json`.                              |
| `payload_too_large`      | 413                                                 | Body over the route's limit (default 64 KB, enforced while streaming). |
| `unauthorized`           | 401                                                 | No valid session cookie.                                               |
| `forbidden`              | 403 (503 in production when no token is configured) | Foreign Host or Origin, or the local server has no token.              |
| `not_found`              | 404                                                 | Unknown URL, or a missing schema or table.                             |

## Database

| Code                    | Status | Meaning                                                                                                       |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `authentication_failed` | 400    | Wrong user or password.                                                                                       |
| `database_not_found`    | 400    | The database does not exist.                                                                                  |
| `ssl_error`             | 400    | TLS mismatch or certificate problem.                                                                          |
| `permission_denied`     | 400    | The role lacks a privilege.                                                                                   |
| `invalid_request`       | 400    | The request is not allowed for this table or column (for example a bad cursor, or a value that does not fit). |
| `not_supported`         | 400    | For example rows of a foreign table.                                                                          |
| `not_connected`         | 409    | A data call before connect or after disconnect.                                                               |
| `too_slow`              | 422    | A sorted or filtered read hit its 5 second limit.                                                             |
| `unreachable`           | 502    | Could not reach the server.                                                                                   |
| `timeout`               | 504    | The operation timed out.                                                                                      |
| `unexpected`            | 500    | Anything else; no detail is exposed.                                                                          |

## Connections, saved data and snapshots

| Code                       | Status |
| -------------------------- | ------ |
| `connection_not_found`     | 404    |
| `connection_limit_reached` | 409    |
| `profile_not_found`        | 404    |
| `workspace_not_found`      | 404    |
| `workspace_limit_reached`  | 409    |
| `invalid_workspace_file`   | 400    |
| `snapshot_not_found`       | 404    |
| `snapshot_limit_reached`   | 409    |
| `snapshot_too_large`       | 413    |
| `invalid_snapshot_file`    | 400    |
| `storage_error`            | 500    |

## Data viewing, SQL and export

| Code                   | Status | Meaning                                                |
| ---------------------- | ------ | ------------------------------------------------------ |
| `data_access_disabled` | 403    | Data viewing is off for this connection.               |
| `rows_busy`            | 429    | A page read is running and the queue is full.          |
| `export_busy`          | 429    | An export is already running on this connection.       |
| `sql_busy`             | 429    | A SQL statement is already running on this connection. |

## Writes

| Code                      | Status | Meaning                                                         |
| ------------------------- | ------ | --------------------------------------------------------------- |
| `writes_not_enabled`      | 403    | Started without `--enable-writes`.                              |
| `writes_not_allowed_here` | 403    | The host is not loopback.                                       |
| `write_not_unlocked`      | 403    | The connection has not been unlocked.                           |
| `wrong_database_name`     | 400    | The typed name did not match.                                   |
| `preview_expired`         | 410    | The preview was used, expired (five minutes), or cleared.       |
| `write_busy`              | 429    | Another write is running on this connection.                    |
| `invalid_change`          | 400    | The change is not valid for the table.                          |
| `not_editable`            | 400    | The table or column cannot be edited.                           |
| `row_changed`             | 409    | A column no longer holds the value you saw, or the row is gone. |
| `unique_violation`        | 409    | A row with the same value already exists.                       |
| `foreign_key_violation`   | 409    | A foreign key would be broken.                                  |
| `not_null_violation`      | 400    | A required value is missing.                                    |
| `check_violation`         | 400    | A CHECK rule rejected the value.                                |
| `invalid_value`           | 400    | A value does not fit the column type.                           |
| `locked`                  | 409    | Could not get a lock in time.                                   |
| `retry`                   | 409    | A transient conflict; try again.                                |
| `write_denied`            | 403    | The role may not make this change.                              |
| `has_dependents`          | 409    | A drop is refused while something depends on the object.        |
| `already_exists`          | 409    | The name is already taken.                                      |

## Claude reading a connection (1.11.0)

| Code                           | Status | Meaning                                                                                                                                                                                                                      |
| ------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude_role_not_acknowledged` | 409    | `PUT /api/connections/:id/claude` at the `data` level, and the connected role is a superuser or can read server files or run programs. Send `acknowledgeRole: true` (the dialog's **Share anyway**) or use a read-only role. |

`PUT /api/connections/:id/claude` can also answer `404 connection_not_found` and `403 data_access_disabled` (the
data level needs viewing table data), and `POST /api/claude/pending/:id` answers `404 not_found` ("That request
is no longer waiting.") when the call was already answered, timed out or was given up.

**`/mcp` does not use this shape.** `POST /mcp` answers a guard refusal as `{ "error": { "message": "…" } }`
with no `code`: **401** (a valid token is required), **403** (Host, `Origin` or `Sec-Fetch-Site`), **404**
(no token configured, or nothing shared), **405** for `GET` and `DELETE`. A tool's own failure is **not** an
HTTP error: it is a JSON-RPC result with `isError: true` (or a JSON-RPC error `-32602` for an unknown tool),
with a fixed sentence. A body that is too large or not JSON gets the usual `payload_too_large` or
`invalid_json`.

The "Meaning" text is an interpretation of each code's name and where the project uses it; the exact
user-facing sentences are fixed strings in the adapter and service code and are not reproduced here.

---

**Sources:** [`packages/shared-types/src/api-error.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/shared-types/src/api-error.ts),
[`apps/web/lib/server/error-response.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/error-response.ts),
[`apps/web/app/mcp/route.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/app/mcp/route.ts),
[`apps/web/lib/security/request-guard.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/security/request-guard.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/architecture.md).
