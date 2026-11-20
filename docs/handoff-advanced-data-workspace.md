# Handoff: the advanced data workspace (1.8.0 and 1.9.0)

Written 2026-11-20 for whoever continues this work (a person or a fresh Claude session). It is meant to be read alone: it says where things stand, what is left, how to work in this repository without losing an hour to its traps, and what the owner expects. The design is in `docs/advanced-data-workspace-plan.md` (read its sections 1 to 16 next); this file does not repeat it, it points into it.

## 1. Where things stand

**Repository:** `/Users/shubham/Desktop/Repos/NEXT JS/pg-visualizer` (GitHub: `ShubhamTiwari909/pg-visualizer`, a monorepo: `apps/web` Next.js, `packages/{cli,database-core,postgres-adapter,shared-types,canvas-engine}`).

**Released and merged to `main`** (none of these is published to npm: that is the owner's step):

- 1.5.x, 1.6.0 (SQL tab), 1.7.0 (Migrations tab, PR #24, `393fc1e`), 1.7.1 (hardening, PR #25, `dc65e76`).

**In progress: branch `feat/data-workspace-1.8.0`** (cut from `main` at `dc65e76`, **not pushed, no PR yet**). Commits on it:

| Commit    | What                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `e82dc09` | the Phase 4 plan (`docs/advanced-data-workspace-plan.md`)                                                    |
| `ec394db` | the 12 decisions accepted, decision 153                                                                      |
| `a40c15b` | **D0**: spikes (validation in a temp table, JSON text tools, streamed export), decision 154, plan section 15 |
| `c4714f5` | **D1**: advanced filters (groups, operators, filter by cell, saved shapes), decision 155, plan section 16    |

`docs/advanced-data-workspace-plan.md` section 11 has the milestones D0 to D7. **D0 and D1 are done.** The branch `docs/advanced-data-workspace-plan` is an older copy of the two plan commits; ignore it (it can be deleted).

**All checks were green at `c4714f5`:** prettier, eslint, `npm run typecheck`, 2,880 vitest tests, `verify:package`, and the full Playwright suite (110 tests). PostgreSQL 17 only locally; the 12 to 18 matrix runs in CI.

## 2. The task, in the owner's words and decisions

The owner asked for "Phase 4, Advanced Data Workspace": CSV import/export, bulk editing, advanced filters, a JSON editor, data validation, **plan first**. They accepted every recommendation of plan section 13 (decision 153):

- **Two releases.** **1.8.0** = advanced filters, JSON editor, validation, export (**nothing in it writes a row**). **1.9.0** = bulk editing and import (the write side, with its own independent review).
- Export: 100,000 rows / 64 MB defaults, file says when it was cut. Import: CSV only, UTF-8 only, all-or-nothing in one transaction, insert only, "skip failing rows + rejects file" only as an explicit choice after validation. Bulk update: selected rows only, 500 at most. Validation: schema rules only, in a temporary table, plus the Migrations pre-flight. JSON editor: lazy Monaco, hand-written tokenizer. Saved filters: shape only, never values. `COPY` vs batched `INSERT`: measured in D5/D6 (batched `INSERT` unless more than about 5x slower).

## 3. What is left

### 1.8.0 (continue on `feat/data-workspace-1.8.0`)

| Milestone   | Work                                                                                                                                                                                                                                                                                                             | Starting points                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D2**      | **JSON editor** (plan section 5). A dialog from the cell, the edit form and the insert form: colours, error position, Format/Minify, tree for big documents, diff against the loaded value, 1 MB edit cap.                                                                                                       | `apps/web/features/json/json-text.ts` (**done in D0**: `checkJson`, `formatJson`, `layoutJson`, 28 tests); `features/sql/monaco-setup.ts` (lazy Monaco, curated imports); `features/writes/value-field.tsx` and `row-edit.ts` (where JSON is edited today) |
| **D3**      | **Validation** (plan section 6). `POST .../rows/validate`; the temp-table check, uniqueness and foreign keys by read-only queries, report with row numbers and no values; "Validate" next to "Preview" in the single-row edit and insert forms; the **pre-flight in the Migrations tab** (section 6.3).          | `postgres.adapter.validation-spike.test.ts` (the pinned facts: no defaults, no indexes, relax NOT NULL for default/identity columns, bisect failing rows, cast cells one by one to find the column); `apps/web/features/migrations/plan-view.tsx`          |
| **D4**      | **Export** (plan section 8). `POST .../rows/export`, a cursor read in batches of 1,000 streamed to the browser, CSV/TSV/JSON/NDJSON, masked columns left out unless revealed, formula defusing, 100k rows / 64 MB, cancel; dialog with progress.                                                                 | `postgres.adapter.export-spike.test.ts` (0.5 s for 100k rows); `features/sql/export.ts` (the existing result export with the apostrophe defusing); `features/sql/` runner (cursor, deadline, cancel)                                                       |
| **Release** | README, `docs/getting-started.md`, `SECURITY.md`, `docs/threat-model.md` (a section for export and validation, plus the independent review of the validation), `docs/decisions.md`, `CHANGELOG.md`, version **1.8.0** (root and `packages/cli` `package.json`, and the three places in `package-lock.json`), PR. | Copy how 1.7.0 and 1.7.1 did it (`git show 393fc1e --stat`, `git show dc65e76 --stat`).                                                                                                                                                                    |

**Do the independent review before the 1.8.0 PR** (section 6 of this file says how). Its target is D3 (the temp table, its read-only queries, what it can touch) and D4 (what leaves the machine).

### 1.9.0 (a new branch from `main` after 1.8.0 merges)

| Milestone | Work                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D5**    | **Bulk editing** (plan section 7): selection in the grid by key (use `apps/web/lib/use-grid-navigation.ts`), operations `update_rows`, `edit_cells`, `delete_rows` added to the write path's operation union, per-row conflicts reported **before** writing, review diff, validation, `affected = previewed` or rollback. Also the **COPY vs INSERT measurement** here or in D6. |
| **D6**    | **Import** (plan section 9): browser CSV parser (delimiters, quotes, line breaks inside quotes, BOM, header, UTF-8 only), mapping screen (columns chosen by hand, never used as identifiers), whole-file validation, `insert_rows` operation in batches of 500 in one transaction, progress and cancel, rejects file.                                                            |
| **D7**    | Polish, docs, the **independent review of the write side (D5 + D6)**, fixes, version **1.9.0**, PR.                                                                                                                                                                                                                                                                              |

**The write path to extend** (read these before designing D5/D6):

- Operation types: `packages/database-core/src/changes.ts` (`update_row`, `insert_row`, `delete_row` and the structure changes).
- Builders and the three layers' enforcement: `packages/postgres-adapter/src/writes/` (`rows.ts`, `sql.ts`, `guard.ts`, `catalog.ts`, `structure.ts`; `rules.test.ts` and `builders.test.ts` pin the rules).
- Service: `apps/web/lib/server/write-service.ts` (`preview`, `apply`, `PreviewStore` in `preview-store.ts`, `lock`/`unlock`), routes in `apps/web/app/api/connections/[id]/writes/`.
- Web: `apps/web/features/writes/` (`row-editing.tsx`, `change-dialog.tsx`, `row-edit.ts`, `value-field.tsx`, `fk-lookups.ts`).
- Rules: `tests/security.test.ts` (rows and writes sections) and `tests/architecture.test.ts` (only the write service may reach the write capability): **extend these tests in the same commit as the code**; they exist to stop quiet changes.
- Plan docs to reread: `docs/data-editing-plan.md` sections 5 (guardrails), 6.3 and 6.4 (write path, fixed errors by SQLSTATE).

## 4. How to work here (the traps)

**Environment**

- Local test PostgreSQL: Docker container `dc-test-pg` (postgres:17) on `127.0.0.1:54329`. Export before tests that need it:
  `export DATACANVAS_TEST_PG_URL="postgresql://postgres:<the test password>@127.0.0.1:54329/postgres?sslmode=disable"`. Without it most adapter tests **skip silently** ("N skipped" is the sign). `psql` is at `/opt/homebrew/opt/postgresql@17/bin/psql` and on PATH.
- Shell is zsh on macOS: **`sed -i` needs `-i.bak`** (or use Python for edits); `timeout` does not exist; a glob with no match is an error (`--include=*.ts` after a path fails, use `find`/`grep -r` carefully).
- **Heredocs through the tool turn ` ` and the like into real characters.** If you write those escapes in source, check the file afterwards (a regex with a raw U+2028 breaks the parser). Write them with Python `'\\u2028'` if needed.

**Build and test**

- Packages are consumed from **`dist`**: after any change in `packages/*`, run `npm run build -w @datacanvas/database-core` (or `npx tsc -b`) before running adapter/web tests, or they test stale code. (This cost real time twice.)
- Format first: `npx prettier --write <paths>` rewraps lines, which breaks scripted string replacements made before it. Re-grep before replacing.
- Full local gate, in order: `npx prettier --check .`, `npx eslint .`, `npm run typecheck`, `npx vitest run`, `npm run package`, `npm run verify:package`, `npm run release:check`, `npx playwright test`. **Playwright runs the packaged app** (`.package/`): **`npm run package` before every e2e run**, or you test the old UI.
- Rule tests (`tests/*.test.ts`) pin code shapes with regexes (for example "only `matches` may use `~*`", "only `filter-shapes.ts` may touch `localStorage`"). When a deliberate change breaks one, **update the rule to say the new truth, narrowly**, do not delete it (D1 did this three times: see `tests/security.test.ts`).
- `vitest` may flake under load (`postgres.adapter.rows-sort.test.ts` once timed out at 5 s); re-run alone before suspecting the code.
- e2e conventions: fixtures in `e2e/fixtures.ts` (`app`, `database`), the connect flow is copy-pasted per spec, axe runs with the WCAG 2.0/2.1 A and AA tags in **both themes and a 390 px phone** (see `e2e/data-filter-advanced.spec.ts` or `e2e/migrations.spec.ts` for the pattern, including waiting for the theme menu to close before running axe). Monaco can't be clicked on its 1 px textarea: click `.monaco-editor .view-lines`.

**Codebase conventions**

- Decisions are numbered in `docs/decisions.md` (last: **155**; next **156**). Add one for every design choice that is not obvious; plan docs get "What Dn found" sections (15 and 16 exist).
- Security stance, always: **values never logged, saved, cached or echoed in an error**; errors map from SQLSTATE to fixed text; every identifier from the catalog and quoted; every value bound; no `CASCADE`; masked ("hidden") columns can be neither sorted nor filtered nor exported unless revealed.
- `database-core` must stay free of drivers, React and Next (an architecture test enforces it). `shared-types` holds the zod contracts; a contract test keeps its operator list in step with the core's.
- React lint (`react-hooks/set-state-in-effect`) forbids setting state in an effect: use lazy `useState` initializers and `key` to reset.
- Old data: snapshots are format 3 with a sparse `ddl` block; older files must still open.

## 5. Working agreements with the owner (important)

- **Never merge or publish without their explicit go-ahead.** They say "Merge it" / "Start M6"-style short commands; each is a go-ahead for that one thing only. Publishing to npm is always **their** step (the publish script `scripts/publish.mjs`, instructions in `docs/releasing.md`); give them the commands, do not run `--publish`.
- Pushing a branch and opening a PR for a release is expected once a release milestone is reached and they have said to proceed; do it with the owner's account: `GH_TOKEN=$(gh auth token --user ShubhamTiwari909) gh ...` and for git: `GH_TOKEN=... git -c credential.helper= -c "credential.helper=!gh auth git-credential" push -u origin <branch>`. The active `gh` account (`Shubham-Tiwari-Anywhere`) cannot write to the repo.
- Merge style used so far: squash (`gh pr merge N --squash`). CI had flaky `apt` failures at the Playwright install step; re-running the failed job (`gh run rerun <id> --failed`) fixed it. Do not edit CI without asking.
- The owner expects a short summary after each milestone with a clear yes/no next step, plain language, and honest limits ("not verified", "PostgreSQL 17 only locally"). They run the app locally from the packaged build (`npm run package && npm start`, then open the printed tokened link).
- **Independent review before each release** (it found real high-severity bugs in 1.5.2, 1.6.0 and 1.7.0): spawn a fresh agent, give it the files and what the code is for, **not your conclusions**, ask it to reproduce each finding with a throwaway test and to change no source. Fix every finding with a test; record the table in `docs/threat-model.md` (see 8b and 9b) and the CHANGELOG "Security" section.
- Organization rules (from the admin): professional tone; never repeat passwords or keys; treat customer names/emails as confidential; legal/HR/security-policy questions get general guidance and a pointer to the internal team; no commitments about pricing, SLAs or contracts in customer-facing drafts. The `elkjs` license (EPL-2.0 OR GPL-3.0-or-later inside an Apache-2.0 package) is an open question for the internal team (`docs/releasing.md`).
- The app's permission classifier once refused `mcp__ccd_pr__set_monitor` (turning on Auto-fix); do not work around it, ask the owner.

## 6. Suggested next moves, in order

1. `git checkout feat/data-workspace-1.8.0`; run the full gate once to confirm the starting point is green.
2. **D2** (JSON editor). Start from `features/json/json-text.ts`; register a Monarch tokenizer with `setMonarchTokensProvider` from `editor.api` (no JSON language service: see decision 154); reuse `loadMonaco` and `applyAppTheme`. Add a unit test for the tokenizer rules where possible and an e2e for the dialog (axe, dark, phone). Remember `jsonb` conflicts compare as `jsonb`, `json` as text (plan section 5).
3. **D3** (validation), the part where the facts from the spike matter most; build it as a pure core function plus one adapter method plus one route; add rule tests ("never the real table", "no triggers", "no sequence advanced").
4. **D4** (export), then the 1.8.0 release docs, the **independent review**, the PR.
5. Ask the owner whether to push `feat/data-workspace-1.8.0` earlier for CI (the PostgreSQL 12 to 18 matrix runs only in CI, and it is the only place the D0 spike facts are checked on versions other than 17).
6. After 1.8.0 merges, branch from `main` for 1.9.0 and follow section 3.

## 7. Things that are decided but easy to forget

- Groups of filter conditions are **flat numbers 1 to 3** (decision 155), not a tree; "(A and B) or C" is deliberately not expressible.
- Validation **never copies defaults or indexes** into the temp table and **drops NOT NULL for columns the database fills itself**; it finds failing rows by **halving batches** and the failing column by **casting the row's cells one at a time**; it reports **row numbers and rule names, never values** (decision 154).
- JSON **Format and Minify re-write the checked tokens**; they must never go through `JSON.parse`/`JSON.stringify` (numbers would change).
- Export formula defusing is the leading apostrophe already used by `features/sql/export.ts`.
- Held-step and rename logic in Migrations is finished and reviewed; do not touch it for this phase except for the pre-flight button (plan section 6.3).
- Open follow-ups from earlier work, unrelated to this phase: a single huge cell is still read whole (SQL tab); the Phase 4 plan's `COPY` measurement.
