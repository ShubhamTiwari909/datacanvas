# Release checklist (Phase 13)

Everything here needs a person with the right accounts and authority. The code is ready to release only when `npm run release:check` prints "No blockers."

## Decisions only the maintainer can make

1. **License.** Choose one with the relevant internal team, add a `LICENSE` file, and set `"license"` in the root `package.json`. Until then all rights are reserved. Note that `elkjs` (automatic layouts) is licensed **EPL-2.0 OR GPL-3.0-or-later**; confirm that shipping it inside the package fits the license you choose and your organization's policy (see decision 69 in `decisions.md`).
2. **Repository.** Create the GitHub repository, push, then set `"repository"`, `"homepage"` and `"bugs"` in the root `package.json`. The build copies them into the published package. Relative images and links in the README resolve against the repository once it is set.
3. **Security contact.** Replace the placeholder in `SECURITY.md` with a monitored address or GitHub's private vulnerability reporting.
4. **Package name.** `datacanvas` was free on npm when last checked; nothing reserves it until you publish. Check again right before.
5. **Version.** Set `1.0.0` in `packages/cli/package.json` (the package takes its version from there) and rename "Unreleased" in `CHANGELOG.md`.

## Accounts and credentials (never put these in the repository)

- An npm account that will own the package, with two-factor authentication.
- **Trusted publishing:** on npmjs.com, after the first publish, add this repository and the workflow `release.yml` as a trusted publisher. The first publish of a brand-new package may need to be done once by hand with `npm publish --access public` from `.package/`; ask npm's documentation which applies to you at that time.
- Branch protection on `main` so CI must pass.

## Steps

1. `npm ci && npm run check` (with a test PostgreSQL, see `examples/docker-compose.yml`).
2. `npm audit --omit=dev`.
3. `npm run package && npm run verify:package && npm run release:check`.
4. `npm run test:e2e` and `npm run screenshots` if the interface changed.
5. Run CI on all three operating systems; fix whatever the first run shows (it has never run).
6. Check the tarball contents with `npm pack --dry-run` in `.package/` (only `bin/`, `web/`, `node_modules/`, README, `package.json`, LICENSE).
7. On a clean machine with only Node installed: `npx --yes datacanvas`, connect a real (read-only) database, add tables, save, restart, restore.
8. Tag and push: `git tag v1.0.0 && git push origin v1.0.0`. The release workflow checks, packs and publishes with provenance.
9. Verify: `npx --yes datacanvas@1.0.0 --version` from a fresh folder; create the GitHub release from the changelog text.

## Not done yet

- A short demo GIF for the README (screenshots exist; a recording needs a screen-capture tool).
- Verification on Windows and Linux (CI is configured but has not run).
- An independent security review.
