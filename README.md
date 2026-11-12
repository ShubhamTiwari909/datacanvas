# DataCanvas

A local-first visual database explorer. Connect a PostgreSQL database, explore its structure, and see tables and relationships on an interactive canvas.

> **Status: early development (Phase 1, UI shell only).** There is nothing to run for end users yet; the app shows a welcome screen and cannot connect to a database.

**Your database. Your machine. Your control.**

- Everything runs on your computer and binds to `127.0.0.1` only.
- Database credentials never leave your machine. Only schema metadata is read, never table rows.
- No account, no cloud, no telemetry.

## Planned usage

```bash
npx --yes datacanvas
```

The only requirement for end users will be Node.js 20 or newer. No clone, no build step, no `.env` file.

## For contributors

Requirements: Node.js 20.9 or newer and npm 10 or newer.

```bash
npm install        # installs every workspace and links them together
npm run dev        # builds the packages, then starts the web app at http://127.0.0.1:4747
npm run build      # compiles the packages, then makes the production Next.js build
npm run check      # format check + lint + typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and [docs/architecture.md](docs/architecture.md) for how the pieces fit together.

## Repository layout

```text
apps/
  web/             Next.js app: UI now, /api route handlers from Phase 2
packages/
  shared-types/    Constants and (from Phase 3) Zod schemas shared across workspaces
  cli/             The `datacanvas` command (placeholder until Phases 2 and 11)
docs/              Architecture notes and decision records
pg-visualizer.md   The phase-by-phase development plan
```

## Development plan

The project is built in small phases, each ending with a learning checkpoint. The full plan is in [pg-visualizer.md](pg-visualizer.md).
