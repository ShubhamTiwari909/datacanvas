# Architecture

This page is extended in every phase. It describes how the pieces fit together today and where they are headed.

## Phase 0: foundation

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

## Phase 1: the web app shell (`apps/web`)

A Next.js 16 App Router app. It has no API and no database code yet.

```text
apps/web/
├── app/
│   ├── layout.tsx        root layout (Server Component), sets <html>/<body> and metadata
│   ├── page.tsx          "/" route: AppShell + WelcomePanel
│   ├── loading.tsx       route-level loading UI (shown while the page is working)
│   ├── error.tsx         route-level error boundary (Client Component)
│   └── globals.css       Tailwind import + shadcn theme variables
├── components/
│   ├── layout/           Header, Sidebar, AppShell (page frame)
│   ├── states/           LoadingState, EmptyState, ErrorState (reused by every later phase)
│   └── ui/               shadcn/ui primitives (Button, Dialog), generated, owned by us
├── features/connections/ ConnectPostgresButton (client), WelcomePanel
├── lib/utils.ts          `cn()` helper for merging Tailwind class names
├── next.config.ts        standalone output, unoptimized images, monorepo trace root
├── postcss.config.mjs    Tailwind v4 PostCSS plugin
└── tsconfig.json         extends the base but uses bundler module resolution
```

### Server vs Client Components

By default every file in `app/` is a **Server Component**: it renders on the server and sends HTML, with no JavaScript for that component. A file is a **Client Component** only if it starts with `"use client"`; that is required when it uses state, effects or browser events.

| Component                                                                                               | Kind   | Why                                                            |
| ------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| `layout.tsx`, `page.tsx`, `AppShell`, `Header`, `Sidebar`, `WelcomePanel`, `EmptyState`, `LoadingState` | Server | Pure markup, no interactivity                                  |
| `ConnectPostgresButton`                                                                                 | Client | Owns `useState` for "is the dialog open?"                      |
| `ErrorState`, `app/error.tsx`                                                                           | Client | Has click handlers; error boundaries must be client components |

Rule of thumb: keep `"use client"` on the smallest, leaf-most component that needs it.

### Packaging-related settings

- `output: "standalone"`: `next build` writes `.next/standalone/` containing `server.js` and only the `node_modules` it needs (about 50 MB). Phase 2 packages this folder into the npm package.
- `outputFileTracingRoot` points at the repo root, otherwise files outside `apps/web` would be missing from the standalone folder.
- `images.unoptimized`: avoids the native `sharp` dependency.
- `dev` runs `next dev -H 127.0.0.1 -p 4747`, so the dev server is only reachable from this machine.

### Build order

`apps/web` imports `@datacanvas/shared-types`, which resolves to that package's compiled `dist/`. So the root `dev` and `build` scripts run `tsc -b` first to build the packages, then start Next.js.
