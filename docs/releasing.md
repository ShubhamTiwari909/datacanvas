# Releasing

How a version of DataCanvas gets to npm, and what is still open. The package is published as **`@shubhamtiwari909/datacanvas`** (the plain name `datacanvas` was refused by npm as too similar to an existing package, `data-canvas`). The command users run is still `datacanvas`.

## Publishing a version

1. Set the version in `packages/cli/package.json` (the package takes its version from there) and add its section to `CHANGELOG.md` (rename "Unreleased").
2. `npm run check` (with a test PostgreSQL for the database tests, see `examples/docker-compose.yml`), `npm run test:e2e`, and `npm run test:pg-matrix` before every release (the database tests run on one version locally; the matrix is 12 to 18).
3. `npm login` with the account that owns the package (two-factor authentication on).
4. `npm run publish:npm` is a rehearsal: it rebuilds, tests the packed tarball, runs the release gate (`npm run release:check`), refuses a version that already exists, and does everything except upload (`--dry-run`).
5. `npm run publish:npm -- --publish` uploads. It only publishes when `npm whoami` is the expected account (`EXPECTED_NPM_USER` in `scripts/publish.mjs`), then waits for the registry to list the version. A new version can take a minute to appear, and npm may hold an upload for approval; if the script says the version is not visible yet, check the package page on npmjs.com and do not run it again for the same version.
6. Check it from a clean folder: `npx --yes @shubhamtiwari909/datacanvas@<version> --version`.
7. Record it: `git tag v<version> && git push origin v<version>`.

A **pre-release** version (for example `1.1.0-rc.1`) is published under the `next` tag so that `npx @shubhamtiwari909/datacanvas` keeps meaning the last stable version; install it with `@shubhamtiwari909/datacanvas@next`. A normal version goes to `latest`. A version can never be published twice, so a mistake means a new version number.

### Tag-driven release (optional)

`.github/workflows/release.yml` runs when a `v*` tag is pushed: the full check, the audit, the tarball test and the release gate, then `npm publish --provenance`. It needs npm "trusted publishing" configured on npmjs.com for this repository and workflow (no token is stored in GitHub). Until that is set up, use the local script and expect that workflow to fail on a pushed tag. Do not publish the same version both ways.

## Repository settings (one-off)

- Turn on **private vulnerability reporting** (SECURITY.md points to it).
- Protect `main` so that CI must pass.

## Still open

- Confirm with the relevant internal team that shipping `elkjs` (EPL-2.0 OR GPL-3.0-or-later, used under EPL-2.0) inside an Apache-2.0 package meets organization policy (decisions 69 and 91), and who the copyright holder in `NOTICE` should be.
- The CI workflow had its first run only recently; Windows and Linux were never tested by hand.
- Managed PostgreSQL services (RDS, Supabase, Neon, Azure) are untested; self-hosted PostgreSQL 12 to 18 passes (`npm run test:pg-matrix`).
- No review by an outside party (see SECURITY.md and docs/threat-model.md).
- No demo GIF in the README (screenshots exist; regenerate with `npm run screenshots`).
