# Contributing to DataCanvas

## Setup

```bash
npm install
npm run check
```

Requires Node.js 20.9+ and npm 10+. Ordinary users never run these commands; they will use `npx datacanvas`.

## Scripts (run from the repo root)

| Script                 | What it does                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `npm run dev`          | Build the packages, then start the web app on 127.0.0.1:4747        |
| `npm run build`        | Build the packages, then the production Next.js app                 |
| `npm run typecheck`    | Type-check the packages (`tsc -b`) and the web app (`tsc --noEmit`) |
| `npm run lint`         | ESLint across the repo                                              |
| `npm run format`       | Prettier: rewrite files                                             |
| `npm run format:check` | Prettier: fail if any file is not formatted                         |
| `npm run check`        | format check, lint and typecheck together                           |
| `npm run clean`        | Remove build output of the TypeScript projects                      |

Run `npm run check` before every commit.

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

## Commits

Use short, imperative commit messages, for example `Add PostgreSQL connection tester`.

## Testing the packed package

The real product is the packed npm package, not the monorepo. After changing anything that affects installation, test the tarball in a fresh folder:

```bash
npm run package
cd .package && npm pack --pack-destination /some/scratch/folder
cd /some/other/fresh/folder
npm install --offline /some/scratch/folder/datacanvas-0.0.0.tgz   # offline: proves nothing is downloaded
./node_modules/.bin/datacanvas --no-open
```

## Integration tests (PostgreSQL)

`npm test` runs without a database: the PostgreSQL integration tests are skipped. To run them, start a disposable PostgreSQL and point `DATACANVAS_TEST_PG_URL` at its `postgres` database:

```bash
docker compose -f examples/docker-compose.yml up -d
export DATACANVAS_TEST_PG_URL="postgresql://postgres:testpass@127.0.0.1:54329/postgres?sslmode=disable"
npm test
docker compose -f examples/docker-compose.yml down -v
```

Each run creates its own uniquely named database and role, loads `examples/ecommerce.sql`, and removes both afterwards. **Never point the variable at a server that holds data you care about.** It works with any PostgreSQL 12 or newer reachable over TCP (for example one started with `initdb` and `pg_ctl` on a spare port), as long as the account may create databases and roles and the server uses password authentication.

## Where DataCanvas stores data

Saved connections (never passwords) and workspaces live in `~/.datacanvas/` (`connections.json` and `workspaces/<id>.json`). Set `DATACANVAS_HOME` to use another folder, for example while testing by hand so your real data is not touched:

```bash
DATACANVAS_HOME=/tmp/dc-test npm run dev
```

Tests always use temporary folders, never the real one.
