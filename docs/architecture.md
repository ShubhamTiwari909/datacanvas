# Architecture

This page is extended in every phase. It describes how the pieces fit together today and where they are headed.

## Phase 0 status: foundation only

Nothing user-facing exists yet. The repo contains the build tooling and two placeholder packages that prove the workspace wiring.

```text
pg-visualizer/
├── package.json          root: workspaces, shared scripts, dev tooling
├── tsconfig.base.json    compiler settings shared by every package
├── tsconfig.json         "solution" file: lists the packages for `tsc -b`
├── eslint.config.js      lint rules (bugs and bad patterns)
├── .prettierrc.json      formatting rules
└── packages/
    ├── shared-types/     exports APP_NAME and DEFAULT_PORT
    └── cli/              imports them; prints a message
```

## How a workspace imports another

1. The root `package.json` declares `"workspaces": ["apps/*", "packages/*"]`.
2. `npm install` finds each workspace and creates a symlink for it inside the root `node_modules` (for example `node_modules/@datacanvas/shared-types` points to `packages/shared-types`).
3. `packages/cli` lists `@datacanvas/shared-types` in its `dependencies`, so Node resolves `import ... from "@datacanvas/shared-types"` through that symlink to `packages/shared-types/package.json`, whose `exports` field points at `dist/index.js`.
4. For the compiler, `packages/cli/tsconfig.json` has a project `reference` to `../shared-types`. `tsc -b` builds shared-types first, then cli reads its generated `.d.ts` files.

Because the entry point is the compiled `dist/` output, a package must be built before another can run against it. `npm run build` handles the ordering.

## How the build works

`npm run build` runs `tsc -b` (build mode) at the root. It reads `tsconfig.json`, follows the `references`, and for each package compiles `src/` to `dist/` (JavaScript, type declarations and source maps). Incremental build info is cached so unchanged packages are skipped.

## Target architecture (from the plan)

```text
Browser -> Next.js app (UI + /api route handlers, one process, 127.0.0.1)
              -> database-core (interfaces)
                   -> postgres-adapter (pg)
                        -> PostgreSQL
```

Route handlers stay thin: validate with Zod, call a service, return JSON. The details are added phase by phase.
