---
title: Releasing
description: How a version of DataCanvas reaches npm, the release gate and tag-driven workflow, and what the project lists as still open.
---

The package is published as **`@shubhamtiwari909/datacanvas`** (the plain name `datacanvas` was refused by
npm as too similar to an existing package). The command users run is still `datacanvas`. **Publishing is the
maintainer's step**; this documentation never publishes anything.

## Publishing a version

1. Set the version in `packages/cli/package.json` (the package takes its version from there) and add its
   section to `CHANGELOG.md` (rename "Unreleased").
2. `npm run check` (with a test PostgreSQL for the database tests), `npm run test:e2e`, and
   `npm run test:pg-matrix` if database code changed.
3. `npm login` with the account that owns the package (two-factor authentication on).
4. `npm run publish:npm` is a **rehearsal**: it rebuilds, tests the packed tarball, runs the release gate,
   refuses a version that already exists, and does everything except upload (`--dry-run`).
5. `npm run publish:npm -- --publish` uploads. It publishes only when `npm whoami` is the expected account
   (`EXPECTED_NPM_USER` in `scripts/publish.mjs`), then waits for the registry to list the version. A new
   version can take a minute to appear, and npm may hold an upload for approval; if the script says the
   version is not visible yet, check the package page and **do not run it again for the same version**.
6. Check from a clean folder: `npx --yes @shubhamtiwari909/datacanvas@<version> --version`.
7. Record it: `git tag v<version> && git push origin v<version>`.

A **pre-release** (for example `1.1.0-rc.1`) is published under the `next` tag so `npx
@shubhamtiwari909/datacanvas` keeps meaning the last stable version; install it with
`@shubhamtiwari909/datacanvas@next`. A normal version goes to `latest`. A version can never be published
twice, so a mistake means a new version number.

## The release gate

`npm run release:check` reads the assembled `.package/` and the repository and prints **every** blocker (not
just the first): package name pattern, real version, `license`, a `LICENSE` file, `repository`, `bugs`,
`engines.node`, `bin.datacanvas`, no install scripts, and `NOTICE` / `THIRD-PARTY-NOTICES.md`. It decides
nothing for the maintainer. Run `npm run package` first.

## Tag-driven release (optional)

`.github/workflows/release.yml` runs when a `v*` tag is pushed: the full check, the audit, the tarball test and
the release gate, then `npm publish --provenance`. It needs npm **trusted publishing** configured on npmjs.com
for this repository and workflow (no token is stored in GitHub): a trusted publisher of type GitHub Actions with
owner `ShubhamTiwari909`, repository `datacanvas` (renamed from `pg-visualizer` on 2026-11-24) and workflow
`release.yml`. The workflow installs npm 11.5.1 or newer first: older npm never uses trusted publishing, and the
registry answers 404. Until that is set up, use the local script and expect that workflow to fail on a pushed
tag. **Do not publish the same version both ways.**

## Repository settings (one-off)

- Turn on **private vulnerability reporting** (`SECURITY.md` points to it).
- Protect `main` so that CI must pass.

## Still open (from the maintainers' notes)

- Confirm with the relevant internal team that shipping `elkjs` (EPL-2.0 OR GPL-3.0-or-later, used under
  EPL-2.0) inside an Apache-2.0 package meets organisation policy (decisions 69 and 91), and who the copyright
  holder in `NOTICE` should be.
- Windows and Linux were never tested by hand; the CI workflow had its first run only recently.
- Managed PostgreSQL services (RDS, Supabase, Neon, Azure) are untested.
- No independent security review. (`docs/releasing.md` still lists "no full Content-Security-Policy"; since 1.10.0 every page has one with a nonce, with the residual risks listed in [Known limits](/security/limits/).)
- No demo GIF in the README (regenerate screenshots with `npm run screenshots`).

---

**Sources:** [`docs/releasing.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/releasing.md),
[`scripts/release-check.mjs`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/scripts/release-check.mjs),
[`scripts/publish.mjs`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/scripts/publish.mjs),
[`.github/workflows/release.yml`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/.github/workflows/release.yml),
[`CHANGELOG.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/CHANGELOG.md).
`release.yml` and `publish.mjs` were not opened; their behaviour is as described in `docs/releasing.md`.
