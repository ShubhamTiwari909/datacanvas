---
title: Testing
description: The four test layers, how to run each, the PostgreSQL integration setup, and what CI runs.
---

## The layers

| Layer                 | Tool                  | Needs                                              | What it proves                                                                                                           |
| --------------------- | --------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Unit                  | Vitest                | nothing                                            | Pure logic, schemas, the request guard, workspace migration, CLI helpers                                                 |
| Integration           | Vitest                | a disposable PostgreSQL (`DATACANVAS_TEST_PG_URL`) | The PostgreSQL adapter and services against a real server; the awkward-schema fixture; performance on a 600-table schema |
| Rule tests (`tests/`) | Vitest                | nothing                                            | Architecture and security rules that fail when someone breaks them quietly                                               |
| End to end (`e2e/`)   | Playwright (Chromium) | the packaged app and a test PostgreSQL             | The real packaged app in a real browser                                                                                  |

Vitest includes `apps/**/*.test.ts`, `packages/**/*.test.ts` and `tests/**/*.test.ts` (`vitest.config.ts`),
with the `@/` alias mapped to `apps/web`.

```bash
npm test                 # tsc -b, then vitest run (database tests are skipped without a database)
npm run test:watch
npm run package && npm run test:e2e
npm run verify:package
npm run test:pg-matrix
```

## PostgreSQL integration tests

`npm test` runs without a database; the PostgreSQL integration tests are skipped. To run them, start a
disposable PostgreSQL and point `DATACANVAS_TEST_PG_URL` at its `postgres` database:

```bash
docker compose -f examples/docker-compose.yml up -d
export DATACANVAS_TEST_PG_URL="postgresql://postgres:testpass@127.0.0.1:54329/postgres?sslmode=disable"
npm test
docker compose -f examples/docker-compose.yml down -v
```

Each run creates its own uniquely named database and role, loads `examples/ecommerce.sql`, and removes both
afterwards. The compose file binds `127.0.0.1:54329` and keeps data in `tmpfs`. **Never point the variable at a
server that holds data you care about.** Any PostgreSQL 12 or newer reachable over TCP works, as long as the
account may create databases and roles and the server uses password authentication.

`npm run test:pg-matrix` (`scripts/pg-matrix.mjs`) runs all PostgreSQL-facing tests against versions 12 to 18,
one Docker container per version (it downloads images).

## The shared contract suite

`@datacanvas/database-core/contract` is a test suite that both `MockDatabaseAdapter` and the PostgreSQL
adapter must pass, which keeps the mock honest. `database-core/testing` also provides the sample shop fixture
used by UI tests and demos.

## Rule tests

- `tests/architecture.test.ts`: `database-core` declares no dependencies and imports only relative modules
  (plus `vitest` in test code); `canvas-engine` depends only on `database-core` and imports no framework.
- `tests/security.test.ts`: routes are guarded and sit behind `proxy.ts`; exactly one route takes SQL text and
  it is strict, POST-only, `no-store`, takes a connection of its own and never logs; no CORS; no all-interfaces
  address; row, cell, validation, pre-flight and export paths are reachable only through the connection service
  behind the data-access check and are kept out of stores, autosave and layouts; bulk changes are single-row
  changes in one transaction; product documents keep their promises' wording.
- `tests/architecture.test.ts` also keeps `packages/mcp` pure (only relative imports and `zod`; no `fetch(`,
  `node:http`, `node:net` or `process.`).
- `tests/security.test.ts` also has rules for the MCP door (1.11.0): `/mcp` has its own guard in `proxy.ts` and
  in the route and the cookie guard never reads an `Authorization` header; no MCP file logs; the tool list is
  pinned at thirteen read-only tools; the MCP files import nothing that writes; the data tools reach data only
  through the SQL service and the page reader; `mcp.json` holds only the pid, the port and the MCP token and is
  written `0600`.
- `e2e/csp.spec.ts` and the end-to-end fixture: every end-to-end test fails when a page breaks the
  Content-Security-Policy (1.10.0).
- `tests/data-dir.test.ts`: the CLI and the web app resolve the data folder the same way.

## End-to-end tests

`e2e/fixtures.ts` starts `.package/bin/datacanvas.mjs` on a free port with a private data folder and a throwaway
database. Specs (listed from `e2e/`): core flow, install QA (wrong password, unreachable database, TLS
mismatch, port in use), performance (400 tables, 5,011 tables in 50 schemas for table search), layout, theme,
overview, paths, health, objects, foreign tables, sidebar search, data viewer, sort, filter, advanced filter,
export, JSON editor, validation, writes, bulk edit, CSV import, migrations, SQL view, run and polish, UI forms,
and screenshots. Failure traces are uploaded by CI from `test-results/`.

## What CI runs

`.github/workflows/ci.yml` (on push to `main` and on pull requests; read-only permissions):

1. **check** (Ubuntu, Node 22, PostgreSQL 17 service): `npm ci`, `npm run check`,
   `npm audit --omit=dev --audit-level=moderate`, `npm run package`, `npm run verify:package`, Playwright
   Chromium install, `npm run test:e2e`.
2. **postgres-versions**: PostgreSQL 12 to 18 matrix, running the adapter, connection-service integration and
   path-finder tests.
3. **install-qa**: macOS, Linux and Windows, Node 20.9.0 and 22: build on Node 22, then install the packed
   tarball and run it on the Node version under test (no database; proves the one-command install).

## Writing tests here

Follow the project rules in [Project rules](/contributing/rules/). In particular: a safety property belongs in
a rule test when a future change could break it silently; and tests that handle secrets plant a distinctive
value and assert it never appears in a response, log or error.

---

**Sources:** [`vitest.config.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/vitest.config.ts),
[`playwright.config.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/playwright.config.ts),
[`.github/workflows/ci.yml`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/.github/workflows/ci.yml),
[`CONTRIBUTING.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/CONTRIBUTING.md),
[`tests/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/tests),
[`e2e/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/e2e),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md) (Phase 12).
Spec contents were inferred from file names and the notes in `docs/architecture.md`; individual specs were not opened.
