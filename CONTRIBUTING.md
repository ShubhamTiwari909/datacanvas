# Contributing to DataCanvas

## Setup

```bash
pnpm install
pnpm run check
```

Requires Node.js `^20.19.0 || >=22.12.0` (20.19 or newer on the 20 line, or 22.12 or newer; not Node 21) and pnpm 10+ to build from source (the build tool loads an ES-module-only dependency with `require()`). Ordinary users never run these commands, and need only Node.js 20.9+; they will use `npx @shubhamtiwari909/datacanvas`.

## Scripts (run from the repo root)

| Script                    | What it does                                                                 |
| ------------------------- | ---------------------------------------------------------------------------- |
| `pnpm run dev`            | Build the packages, then start the web app on 127.0.0.1:4747                 |
| `pnpm run build`          | Build the packages, then the production Next.js app                          |
| `pnpm run typecheck`      | Type-check the packages (`tsc -b`) and the web app (`tsc --noEmit`)          |
| `pnpm run lint`           | ESLint across the repo                                                       |
| `pnpm run format`         | Prettier: rewrite files                                                      |
| `pnpm run format:check`   | Prettier: fail if any file is not formatted                                  |
| `pnpm run check`          | format check, lint and typecheck together                                    |
| `pnpm run test:pg-matrix` | Run the PostgreSQL tests on versions 12 to 18 with Docker (downloads images) |
| `pnpm run clean`          | Remove build output of the TypeScript projects                               |

Run `pnpm run check` before every commit.

## Project rules

1. **Install simplicity is a requirement.** No native modules, no `postinstall` scripts, and no new setup steps for end users.
2. **Keep route handlers thin.** They validate input (Zod), call a service, and return JSON. Database logic lives in framework-free packages.
3. **Never add an endpoint that runs arbitrary SQL.**
4. **No `any`.** Untrusted input is validated at runtime, not asserted.
5. **Every dependency needs a documented purpose.** Record non-obvious choices in [docs/decisions.md](docs/decisions.md).
6. **Never log or return credentials or connection strings.**

## Code documentation conventions

Documentation is written together with the code, not afterwards.

- **File header:** every non-trivial file starts with a short comment describing what it is responsible for and where it fits.
- **Comment the why, not the what.** Complex logic (catalog SQL, cardinality detection, `globalThis` singletons, atomic file writes, origin and host checks, graph and layout code, migrations, shutdown handling) must explain why it is written that way.
- **TSDoc on exported APIs** in packages: purpose, parameters, return value, thrown errors, and any security or performance note.
- **No noise comments.** Prefer clear names first.
- **Keep docs in sync.** When behaviour changes, update the comment, the relevant page in `docs/`, and the README in the same change.

## TypeScript notes

- Packages are ES modules compiled with `module: NodeNext`, so relative imports need a `.js` extension (for example `import { x } from "./x.js"`).
- Use `import type` for type-only imports (enforced by ESLint and `verbatimModuleSyntax`).
- Packages reference each other through TypeScript project references; add a `references` entry when one package depends on another.

## Licensing of contributions

DataCanvas is licensed under the Apache License 2.0. No contributor license agreement or sign-off is required: as section 5 of that license says, a contribution you submit is licensed under the same terms unless you state otherwise. Only submit code you have the right to contribute, and run `pnpm run notices` if you add or change a dependency (every new dependency also needs a documented purpose and a compatible license).

## Commits

Use short, imperative commit messages, for example `Add PostgreSQL connection tester`.

## Testing the packed package

The real product is the packed npm package, not the monorepo. After changing anything that affects installation, test the tarball in a fresh folder:

```bash
pnpm run package
cd .package && npm pack --pack-destination /some/scratch/folder
cd /some/other/fresh/folder
npm install --offline /some/scratch/folder/shubhamtiwari909-datacanvas-<version>.tgz   # offline: proves nothing is downloaded
./node_modules/.bin/datacanvas --no-open
```

## Integration tests (PostgreSQL)

`pnpm test` runs without a database: the PostgreSQL integration tests are skipped. To run them, start a disposable PostgreSQL and point `DATACANVAS_TEST_PG_URL` at its `postgres` database:

```bash
docker compose -f examples/docker-compose.yml up -d
export DATACANVAS_TEST_PG_URL="postgresql://postgres:testpass@127.0.0.1:54329/postgres?sslmode=disable"
pnpm test
docker compose -f examples/docker-compose.yml down -v
```

Each run creates its own uniquely named database and role, loads `examples/ecommerce.sql`, and removes both afterwards. **Never point the variable at a server that holds data you care about.** It works with any PostgreSQL 12 or newer reachable over TCP (for example one started with `initdb` and `pg_ctl` on a spare port), as long as the account may create databases and roles and the server uses password authentication.

## CSV validation benchmark

Point `DATACANVAS_TEST_PG_URL` at a disposable PostgreSQL server and build the packages. Run the same benchmark with PostgreSQL 12 and 18. It uses 100,000 rows per file and checks the exact rejected row numbers. An extended deadline lets it measure the full workload, including cases that exceed the import dialog's 60-second deadline.

```bash
pnpm run build:packages
DC_SPIKE=1 pnpm exec vitest run --maxWorkers=1 --reporter=verbose packages/postgres-adapter/src/postgres.adapter.listall-spike.test.ts -t "release baseline"
```

The 1.13.0 runs on local Docker used the Debian images for PostgreSQL 12.22 and 18.7. The timings include the database round trips and vary with host load.

| 100,000-row input                  | Round trips before → after | PostgreSQL 12 before → after | PostgreSQL 18 before → after |
| ---------------------------------- | -------------------------- | ---------------------------- | ---------------------------- |
| All rows valid                     | 19 → 20                    | 0.54 s → 0.62 s              | 0.32 s → 0.31 s              |
| 1,000 evenly spaced CHECK failures | 42,084 → 24,416            | 20.57 s → 15.62 s            | 20.29 s → 12.73 s            |
| 1,000 evenly spaced type failures  | 62,084 → 36,416            | 27.65 s → 19.44 s            | 28.59 s → 21.99 s            |

## Where DataCanvas stores data

Saved connections (never passwords) and workspaces live in `~/.datacanvas/` (`connections.json` and `workspaces/<id>.json`). Set `DATACANVAS_HOME` to use another folder, for example while testing by hand so your real data is not touched:

```bash
DATACANVAS_HOME=/tmp/dc-test pnpm run dev
```

Tests always use temporary folders, never the real one.
