---
title: Development setup
description: Build and run DataCanvas from a clone, the root npm scripts, and the TypeScript conventions of the monorepo.
---

## Requirements

Node.js `^20.19.0 || >=22.12.0` (not Node 21) and npm 10 or newer. Building needs more than running: the
build tool loads an ES-module-only dependency with `require()`, which Node supports only from those
versions. Users of the published package still need only Node.js 20.9.

## Get running

```bash
git clone https://github.com/ShubhamTiwari909/pg-visualizer.git
cd pg-visualizer
npm install              # installs every workspace and links them together
npm run app              # builds the app and runs it from this clone (about a minute the first time)
npm run dev              # builds the packages, then starts the web app at http://127.0.0.1:4747
npm run check            # format check + lint + typecheck + tests
```

Pass CLI options after `--`: `npm run app -- --port 4900 --enable-writes`.

While experimenting by hand, keep your real data untouched:

```bash
DATACANVAS_HOME=/tmp/dc-test npm run dev
```

## Root scripts

| Script                                    | What it does                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `dev`                                     | `tsc -b`, then `next dev` on 127.0.0.1:4747                                         |
| `build`                                   | `tsc -b`, then the production Next.js build                                         |
| `build:packages`                          | `tsc -b`                                                                            |
| `typecheck`                               | `tsc -b`, the web app's `tsc --noEmit`, and `tsc -p e2e`                            |
| `lint`, `lint:fix`                        | ESLint across the repo                                                              |
| `format`, `format:check`                  | Prettier                                                                            |
| `check`                                   | `format:check` + `lint` + `typecheck` + `test`                                      |
| `test`, `test:watch`                      | `tsc -b` then `vitest run` / `vitest`                                               |
| `test:e2e`, `screenshots`                 | Playwright (needs the packaged app and a test PostgreSQL); regenerate `docs/images` |
| `test:pg-matrix`                          | PostgreSQL-facing tests on versions 12 to 18 with Docker (downloads images)         |
| `package`, `verify:package`               | Assemble `.package/`; test the packed tarball                                       |
| `release:check`, `publish:npm`, `notices` | Release gate, publish script, third-party notices                                   |
| `start`, `app`                            | Run the CLI from `.package/`; package then start                                    |
| `clean`                                   | Remove TypeScript build output                                                      |

The README and `CONTRIBUTING.md` instruct running `npm run check` before every commit.

## TypeScript conventions

- Packages are ES modules compiled with `module: NodeNext`, so **relative imports need a `.js` extension**
  (`import { x } from "./x.js"`).
- Use `import type` for type-only imports (ESLint and `verbatimModuleSyntax` enforce this).
- Packages reference each other through project references; add a `references` entry when one package
  depends on another.
- `@typescript-eslint/no-explicit-any` is an error: untrusted input goes through Zod instead.
- Unused names may be prefixed with `_`.
- Prettier owns formatting (`.prettierrc.json`); `docs/development-plan.md` is excluded from Prettier because
  it is hand-formatted.

## Code documentation conventions

Documentation is written with the code: a file header for every non-trivial file, comments that explain the
**why**, TSDoc on exported package APIs (purpose, parameters, return value, thrown errors, security or
performance notes), no noise comments, and docs kept in sync (the comment, the relevant page in `docs/`, and
the README in the same change).

## Where things go

See [Architecture overview](/architecture/overview/) and [Packages](/architecture/packages/). New HTTP routes
belong under `apps/web/app/api` and must be guarded by `handleRoute`; new database logic belongs in a package,
not a route handler.

---

**Sources:** [`README.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/README.md),
[`CONTRIBUTING.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/CONTRIBUTING.md),
root [`package.json`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/package.json),
[`eslint.config.js`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/eslint.config.js),
[`.prettierignore`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/.prettierignore),
[`tsconfig.base.json`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/tsconfig.base.json).
`CONTRIBUTING.md`'s script table is shorter than the root `package.json`; this page follows the manifest.
