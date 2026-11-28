---
title: Maintaining this site
description: How the documentation site is built and previewed, how it relates to docs/, and how to refresh it when the code changes.
---

This site lives in `site/`, an Astro + Starlight project that is **separate from the pnpm workspace** (the
root `pnpm-workspace.yaml` lists `apps/*` and `packages/*`). It is not published and not part of the npm package. The
pre-existing `docs/` folder is untouched: it stays the project's long-form engineering notes, and this site
organises that knowledge by reader task.

## Run it

```bash
cd site
pnpm install          # first time only; creates site/node_modules and uses site/pnpm-lock.yaml
pnpm run dev          # local dev server (Astro prints the address)
pnpm run build        # static site into site/dist
pnpm run preview      # serve the built site locally
```

Requirements: Node.js `>=22.12.0` (`site/package.json` `engines`). The project pins `astro ^6.4.8` and
`@astrojs/starlight ^0.40.0`. These were chosen because the newest Astro line at the time of writing
required a newer Node 22 patch than the repository's CI baseline; moving to the latest Astro is an upgrade
decision, not a docs change. Check the current Astro and Starlight release notes before bumping.

Pull-request CI installs the docs dependencies with the separate lockfile and runs the build. The static files are in `site/dist/`.

## Layout

```text
site/
├── astro.config.mjs              Starlight integration and the explicit sidebar
├── src/content.config.ts         docs collection (Starlight loader and schema)
├── src/content/docs/             all pages (Markdown; the landing page is MDX)
│   ├── start/  guides/  security/  architecture/  reference/  contributing/
└── src/assets/screenshots/       copies of docs/images/*.png
```

Adding a page: create a Markdown file under `src/content/docs/<section>/`, give it a `title` and
`description`, and add its slug to the sidebar in `astro.config.mjs`. Sidebar order is explicit on purpose.

## Page conventions

- Every page ends with a **Sources** list that links to the files it is based on, using the GitHub `main`
  branch URL of the repository from the root `package.json`.
- Statements that are interpretation are marked **Inference**; things the repository does not establish are
  marked **Unknown**.
- Screenshots in `src/assets/screenshots/` are copies of `docs/images/`. Regenerate the originals with
  `pnpm run screenshots` (needs the packaged app and a test database), then copy them again.
- Do not copy secret values, customer data or connection strings into pages. Document names of configuration
  variables only.

## Keeping it accurate

The pages describe **DataCanvas 1.15.0**. When behaviour changes:

| If this changes…                                                                  | Update these pages                                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A CLI flag or startup behaviour (`packages/cli/src/index.ts`)                     | `start/cli`, `start/installation`, `reference/configuration`                                                 |
| A route in `apps/web/app/api`                                                     | `reference/api`, and `reference/error-codes` if a code was added in `api-error.ts`                           |
| A numeric limit constant                                                          | `reference/limits` and the guide that mentions it                                                            |
| Security wording in `SECURITY.md` or `docs/threat-model.md`                       | `security/*`                                                                                                 |
| A tab or feature (see `CHANGELOG.md`)                                             | the matching `guides/*` page and `architecture/*` page                                                       |
| A package's public surface                                                        | `architecture/packages`                                                                                      |
| The MCP server (`packages/mcp`, `mcp-*.ts`, `/mcp`, `datacanvas mcp`, `mcp.json`) | `guides/use-with-claude`, `architecture/mcp`, `security/*`, `reference/api`, `reference/limits`, `start/cli` |
| The Content-Security-Policy (`csp.ts`, `proxy.ts`)                                | `security/local-server`, `security/model`, `architecture/request-lifecycle`                                  |

A reasonable review step is to compare the version in the root `package.json` with the version stated on the
landing page, and to scan `CHANGELOG.md` entries newer than that.

## Known inconsistencies in the source notes

While generating this site, these differences were found between older notes and newer code. The site follows
the code and changelog:

- `docs/architecture.md` says adding a whole schema is capped at 200 tables; the code constant
  `MAX_TABLES_ADDED_AT_ONCE` is 1,000.
- `docs/threat-model.md` ("Not covered") and `docs/releasing.md` ("Still open") still list "a full
  Content-Security-Policy" as missing, although 1.10.0 added one (residual: inline styles, `'strict-dynamic'`).
- The CHANGELOG entry for 1.10.0 says the INSERT script sets `DateStyle`, `IntervalStyle`,
  `extra_float_digits` and `bytea_output` with `SET LOCAL`. The script sets only `standard_conforming_strings`,
  `datestyle` and `intervalstyle`; the other two are set on the reading side of the export.
- `docs/mcp-server-plan.md` section 4 gives `read_rows` a maximum of 200 rows a page and `explain_query` a 1 MB
  plan; the code allows 100 rows and the 200,000-character answer limit. The site follows the code.
- `SECURITY.md` and `docs/getting-started.md` describe the structure level as names, types, keys, indexes,
  foreign keys and statistics; the structure tools also return column defaults, comments and constraint
  definitions, which can hold a literal.
- `docs/architecture.md` keeps phase-by-phase "what is not covered" notes (for example "nothing has been
  published") that predate later releases.

---

**Sources:** [`site/astro.config.mjs`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/site/astro.config.mjs),
[`site/package.json`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/site/package.json),
root [`package.json`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/package.json) (`workspaces`),
[`CHANGELOG.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/CHANGELOG.md).
