# Decision records

Short records of choices that are not obvious from the code. Newest at the bottom. Each entry says what we decided, why, and what we gave up.

## 1. Next.js route handlers instead of a separate backend server

**Decision:** the API is `app/api/**/route.ts` inside one Next.js app. No Fastify or Express.

**Why:** a browser cannot speak the PostgreSQL protocol, so server-side code is required, but Next.js already runs Node. One app means one process and one port, no CORS or proxy, and simpler packaging for `npx`.

**Trade-off:** less built-in structure than Fastify. We keep route handlers thin and put all database logic in framework-free packages (`database-core`, `postgres-adapter`) so a dedicated server stays possible later.

## 2. PostgreSQL only for v1

**Decision:** MongoDB is deferred. The adapter interface in `database-core` stays so other databases can be added later.

**Why:** a focused first release. Avoid abstractions for databases we are not building.

## 3. No native dependencies, no postinstall scripts

**Decision:** nothing that needs compiling or platform-specific binaries (for example `keytar`, `sharp`, `better-sqlite3`, `pg-native`).

**Why:** the end user should only need Node.js and one `npx` command. Native modules fail on some machines and slow the first run.

**Consequence:** no OS-keychain password storage in v1; Next.js image optimization stays disabled.

## 4. Credentials are memory-only; workspaces are files

**Decision:** database passwords live only in server memory for the current run. Connection profiles (without passwords) and workspaces are JSON files in `~/.datacanvas/`.

**Why:** avoids storing secrets on disk. Files are used instead of browser IndexedDB because IndexedDB is tied to the origin including the port; a fallback port would silently hide saved workspaces.

## 5. Fixed default port 4747

**Decision:** try 4747 first, fall back to another free port only if needed.

**Why:** a stable origin between runs keeps behaviour predictable and makes the security checks (Host and Origin validation) simple.

## 6. Monorepo with npm workspaces and TypeScript project references

**Decision:** one repo, npm workspaces (`apps/*`, `packages/*`), and `tsc -b` with project references for the plain TypeScript packages.

**Why:** shared types and database packages are consumed by several workspaces. npm workspaces needs no extra tool; project references give correct build order and incremental builds.

**Note:** the Next.js app (Phase 1) uses its own bundler resolution and overrides the `module` settings from `tsconfig.base.json`.

## 7. Minimum Node version

**Decision:** `engines.node` is `>=20.9.0`.

**Why:** confirmed in Phase 1: Next.js 16.4.6 declares `engines.node >=20.9.0`, so that is our floor.

## 8. Package name

**Status:** `datacanvas` returned 404 on the npm registry on 2026-11-12, so it appears to be available. Re-check right before the first publish, since a name can be taken at any time.

## 9. ESLint 9 (not 10)

**Decision:** ESLint is pinned to the 9.x line.

**Why:** `eslint-config-next` pulls in `eslint-plugin-react` and friends, whose declared peer range stops at ESLint 9. Using ESLint 10 produced peer-dependency conflicts. It also cleared the dev-only `minimatch` audit finding that came with ESLint 10's dependency tree. Revisit when the Next.js ESLint plugins support ESLint 10.

## 10. System font stack instead of a web font

**Decision:** the UI uses the operating system's default font (`ui-sans-serif, system-ui, ...`) instead of `next/font/google`.

**Why:** a Google font is downloaded at build time, so offline builds would fail and contributors would need internet access just to build. System fonts need no download and keep the app fully offline. The shadcn CLI generated the Geist font setup; we replaced it.

## 11. shadcn/ui with Radix primitives

**Decision:** shadcn/ui (`radix` base, `neutral` colors) generated into `apps/web/components/ui`.

**Why:** components are copied into the repo (we own and can edit them) rather than imported from a runtime UI library, so there is no extra runtime dependency beyond Radix, `lucide-react` and a few small helpers: `cn` (class-name merging, published by the shadcn maintainer), `class-variance-authority`, `tw-animate-css`, and the `shadcn` package itself, which supplies a CSS file imported by `globals.css`. `npm audit` flags a prototype-pollution advisory in `deepmerge` inside the `shadcn` package; it is used for CSS/CLI tooling, not at request time. Revisit when shadcn publishes a fixed release.
