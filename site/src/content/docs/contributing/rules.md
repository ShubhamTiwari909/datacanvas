---
title: Project rules
description: The non-negotiable rules for changes to DataCanvas and where each is enforced.
---

These are stated in `CONTRIBUTING.md` and reinforced by tests and lint rules.

| #   | Rule                                                                                                                                                 | Enforced by                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | **Install simplicity is a requirement.** No native modules, no `postinstall` scripts, no new setup steps for end users.                              | `scripts/build-package.mjs` fails on any `.node` file and on install scripts; `release:check`              |
| 2   | **Keep route handlers thin.** Validate with Zod, call a service, return JSON. Database logic lives in framework-free packages.                       | Review; `tests/architecture.test.ts` for package independence                                              |
| 3   | **Never add an endpoint that runs arbitrary SQL.** (The SQL tab's single `…/run` route is the sole, read-only exception.)                            | `tests/security.test.ts`                                                                                   |
| 4   | **No `any`.** Untrusted input is validated at runtime, not asserted.                                                                                 | ESLint `no-explicit-any: error`                                                                            |
| 5   | **Every dependency needs a documented purpose.** Record non-obvious choices in `docs/decisions.md`; run `npm run notices` when a dependency changes. | Review; `release:check`                                                                                    |
| 6   | **Never log or return credentials or connection strings.**                                                                                           | Route tests that push a distinctive password through every endpoint; no-`console` rules on sensitive paths |

## Rules that follow from the security model

- **Rows are opt-in and gated.** Do not call `getRows`, `getCell`, `validateRows`, `preflight` or `exportRows`
  outside the connection service, and never before its data-access check.
- **Write capability is reachable only through the write service.** Browser-side helpers are named
  `requestPreview` and `requestApply` so the rule can match by name.
- **A change is a structured operation.** No request schema may grow a key named `sql`, `where`,
  `expression` or `using`.
- **No `CASCADE`** in any statement the app builds.
- **No value in an error, log, preview history or report.** Fixed sentences only.
- **Nothing sensitive in browser storage.** Rows, SQL text, filter values and write previews stay in component
  or store memory and are never persisted; rule tests scan for storage APIs.
- **Every route runs inside `handleRoute`**, and responses are `no-store`.
- **No CORS headers**, and nothing listens beyond `127.0.0.1`.
- **Product documents keep their wording**: statements about what is read or run are checked by tests so that a
  later edit cannot quietly contradict them (for example "only metadata is read" must say "by default").

## Documentation rules

Update the code comment, the relevant `docs/` page and the README in the same change. Statements about one
tab say "this tab" so they cannot be read as product-wide claims.

## Licensing and commits

DataCanvas is Apache-2.0. No CLA or sign-off is required: a contribution is licensed under the same terms
unless you state otherwise (section 5 of the license). Only submit code you have the right to contribute. Use
short, imperative commit messages (for example `Add PostgreSQL connection tester`). One dependency, `elkjs`, is
dual-licensed (EPL-2.0 OR GPL-3.0-or-later) and used under EPL-2.0 (decisions 69, 90, 91); confirm
licensing questions with the relevant internal team.

---

**Sources:** [`CONTRIBUTING.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/CONTRIBUTING.md),
[`eslint.config.js`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/eslint.config.js),
[`tests/security.test.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/tests/security.test.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/architecture.md),
[`README.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/README.md) (License).
The "Enforced by" column mixes verified mechanisms (lint rule, build script guards, named tests) with review as stated in
`CONTRIBUTING.md`.
