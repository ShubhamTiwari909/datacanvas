# Migration Studio plan (1.7.0)

Status: **M0 to M4 done** (2026-11-19: the structure detail and the round-trip harness; the planner for tables, columns, constraints, indexes and foreign keys, 60 round-trip scenarios on a real PostgreSQL; the planner for schemas, extensions, types, sequences, functions, views, triggers, policies and row security, 28 more). M5 and M6 not started. Follows 1.6.0. The questions of section 13 are answered: a new tab, the recommended formats, renames in, owners and grants out, no applying, PostgreSQL 12 to 18.

Phase 3 asks for five things: **compare database environments, generate migration SQL, detect destructive changes, export a migration, and generate a rollback where possible.** DataCanvas already compares two structures; this phase turns a comparison into a script a person can review, trust and run elsewhere.

## 1. What we promise

1. **It writes SQL; it never runs it.** The generated script is text, like the index suggestions in the Health tab and the migration file of 1.5.2. No new route runs anything, so no new way to change a database. (Running or verifying a script is a different feature with its own security design: section 10.)
2. **Structure only.** No row is read or moved. A migration is schema, not data: it does not copy rows, backfill a new column, or convert values. Where a step needs one, the script says so in a comment.
3. **The result is checked, not hoped for.** The oracle is a round trip on a real PostgreSQL: apply the generated script to the "from" database and compare its structure with the "to" one; the difference must be empty. The same for the rollback, where it claims to be complete. Every kind of change has such a test (section 7).
4. **Danger is shown before the script is exported.** Every step carries a risk (safe, takes a lock, rewrites the table, can fail, destroys data, cannot be undone). Steps that destroy data are left out of the exported file, commented, until the person confirms each one.
5. **A rollback says what it cannot do.** It is generated where a change can be reversed in structure, and each step says whether the data survives. A migration that cannot be fully reversed says so at the top, and which steps are why.
6. **Honest limits, written down:** no rename detection unless the person confirms it, no grants or owners in the first version, no data migration, and what the structure reader does not see (section 6) is not compared.

## 2. What we already have (and reuse)

- `diffStructures(before, after)` in `database-core/src/diff.ts`: pure, compares schemas, tables, columns, constraints, indexes, relationships and the objects (views, types, sequences, functions, triggers, extensions, policies), with the exact fields that changed. It works for a snapshot, the live database of any connection, or two different databases (`features/snapshots/compare.ts`).
- `DatabaseStructure` (`structure.ts`): sorted, comparable, no rows. It already holds the full text of index definitions, constraint definitions, view and function definitions.
- `quoteIdentifier`, `quoteLiteral` and the type allow-list (`sql-text.ts`, `postgres-adapter/src/writes/sql.ts`), and the planner's knowledge of what takes a lock or rewrites a table (`writes/structure.ts`, decisions 130 to 133, 139).
- `buildMigration` and `migrationFilename` (`apps/web/lib/server/migration-file.ts`, 1.5.2): a transactional script with comments flattened to one line. The same care applies here.
- The Snapshots tab: choosing two sides and showing a diff (`snapshots-view.tsx`, `diff-view.tsx`, `diffToMarkdown`).

## 3. Design

### 3.1 A planner, as a pure function

New module `packages/database-core/src/migration/` (no dependencies, like `diff.ts`):

```ts
planMigration(from: DatabaseStructure, to: DatabaseStructure, options): MigrationPlan

MigrationPlan {
  steps: MigrationStep[];          // in the order they must run
  reversibility: "full" | "partial" | "none";
  warnings: string[];              // things the plan cannot know or do
}
MigrationStep {
  id: string; object: ObjectRef; kind: StepKind;
  up: string;                       // SQL, ends in a semicolon
  down: string | null;              // the reverse, or null when there is none
  risk: Risk[];                     // safe | lock | rewrite | may_fail | destructive | irreversible
  transactional: boolean;           // false for CREATE INDEX CONCURRENTLY and the like
  dependsOn: string[];              // step ids
  note?: string;                    // one plain sentence for the screen and the comment in the file
}
```

It takes two `DatabaseStructure`s and the options (which changes the person selected, which renames they confirmed, the PostgreSQL version of the target). It makes no network call and reads no clock.

### 3.2 Ordering, which is most of the difficulty

Creating and dropping have opposite orders, and views, functions and foreign keys make cycles:

| Phase  | Order                                                                                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create | schemas, extensions, types (enums, then those that use them), sequences, tables (columns only, no foreign keys), indexes and constraints, **foreign keys last** (so two tables that point at each other work), views by dependency (`dependsOn`), functions, triggers, policies, row-security switches |
| Change | a column's type, nullability and default; a changed view or function is `CREATE OR REPLACE` where PostgreSQL allows it, and drop-and-create otherwise                                                                                                                                                  |
| Drop   | the reverse of create: triggers and policies, views (dependents first), foreign keys, indexes, tables, types, sequences, extensions, schemas                                                                                                                                                           |

A view that reads a column being dropped or retyped forces its own drop and re-create around the change (the same refusal as decision 130, but here the generator does the ordering rather than refusing). No statement ever contains `CASCADE`. A cycle the planner cannot order (two views, or a function and a view, that need each other) is reported as a warning and the pair is emitted in an order with a comment.

### 3.3 Rename suggestions (confirmed by the person, never assumed)

A removed table and an added one with the same columns and types, or a removed column and an added one of the same type in the same place, are offered as "Treat as a rename?" with the evidence. Off by default. If confirmed, the step is `ALTER ... RENAME` (the data survives) instead of a drop and an add (it does not). This is the single feature that most protects data, and it is a suggestion, because a wrong guess is a silent mistake.

## 4. Destructive change detection

Every step is classified, and the classification is the same code the screen, the exported file and the tests use.

| Change                                                                                                                           | Risk                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| drop table, column, schema, type, sequence, function, view, trigger, policy                                                      | **destructive** (data or logic lost), and for a table or column **irreversible** for the data                                    |
| a type change through an assignment cast other than between integer types, or fewer decimals (decision 139), or a shorter length | **destructive** (values rounded or cut)                                                                                          |
| a type change that rewrites the table, or a new default that does                                                                | **rewrite**                                                                                                                      |
| set NOT NULL, add a primary key, a unique constraint, a check or a foreign key on a table that may have rows                     | **may fail**; offered as `NOT VALID` then `VALIDATE CONSTRAINT` where PostgreSQL has it, so the long scan does not hold the lock |
| `CREATE INDEX` on an existing table                                                                                              | **lock**; offered as `CONCURRENTLY` (a step outside the transaction)                                                             |
| remove an enum label, or change the order of labels                                                                              | **irreversible and unsupported**: PostgreSQL cannot do it; the plan says to re-create the type                                   |
| add an enum label                                                                                                                | safe, but **cannot be rolled back** and cannot run inside a transaction together with its use                                    |
| drop a column or table that a view, function, trigger or foreign key uses                                                        | the dependents are named, and the plan orders their drop and re-create around it                                                 |
| anything that takes `ACCESS EXCLUSIVE`                                                                                           | **lock**, named                                                                                                                  |

A migration shows a summary first ("2 destructive, 1 may fail, 3 take a lock"). A destructive step is exported **commented out** until the person confirms it on the screen; confirming is per step, not one switch for all.

## 5. Rollback generation

Each step has a `down`, built beside its `up` so they cannot disagree, and the rollback file is the steps in reverse. What can and cannot be reversed:

| Step                                                                            | Reverse                                    | Data                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| add a column, table, index, constraint, view, type, sequence, schema, extension | drop it                                    | the data in what was added is lost (said)                                |
| drop an index, constraint, view, function, trigger, policy                      | create it again from the definition        | nothing lost                                                             |
| drop a column or a table                                                        | create it again from its definition        | **the rows are gone: irreversible** (the step says so)                   |
| change a view, function, trigger or policy                                      | `CREATE OR REPLACE` the earlier definition | nothing lost                                                             |
| change a default, nullability, a comment                                        | set the earlier value                      | nothing lost (a NOT NULL set again may fail if rows now hold NULL: said) |
| change a column's type                                                          | change it back                             | **lossy** if the change narrowed                                         |
| rename                                                                          | rename back                                | nothing lost                                                             |
| add an enum label                                                               | none: **cannot be rolled back**            |                                                                          |
| drop an enum                                                                    | create it again                            | the values in columns that used it are gone with the columns             |

`reversibility` is `full` only when every step is reversible and loses no data; `partial` when some are not (listed); `none` when nothing is. The rollback file begins with that verdict.

## 6. What the structure reader does not see yet (milestone M0)

A migration is only as complete as the structure it is generated from. The snapshot format records definitions as text for display; to generate SQL it must also record, additively (older snapshots stay valid and are treated as "not recorded", as `objects: null` is today):

- columns: identity kind, generated expression and storage, collation, and that a default is an expression (not a literal);
- constraints: deferrable and initially deferred, `NOT VALID`, a foreign key's `MATCH` type;
- tables: partition key and bounds, inheritance, unlogged, storage parameters, the tablespace;
- sequences: owned-by column, cycle, cache;
- comments on views, functions, indexes, schemas and types (tables and columns are recorded already);
- the server's version (to choose syntax and to warn).

Not in 1.7.0, said plainly: owners and grants (`GRANT`, `ALTER ... OWNER`, default privileges), event triggers, publications and subscriptions, foreign data wrappers and servers, collations and casts defined by the person, rules, and anything in `pg_catalog`. The plan lists them in the warnings of every migration ("not compared: ..."), so no one assumes they were.

PostgreSQL 12 to 18, as the rest of the product; syntax that differs (`NULLS NOT DISTINCT` from 15, `CREATE OR REPLACE` limits, identity and generated columns from 10 and 12) is chosen from the target's version.

## 7. How it is tested

- **The round trip is the oracle.** For each kind of change there is a pair of databases in a container (from, to). Apply `up` to a copy of `from`, read its structure again, and `diffStructures` against `to` must be empty. Apply `down` after it, and the structure must equal `from` again for a step claimed fully reversible. A scenario table (about 150 pairs; each makes two databases today, so M1 moves to one schema per scenario in a single pair) covers every row of sections 4 and 5, with data in the tables, so a rewrite or a failing constraint really happens.
- **Hostile names.** The same round trip with identifiers and literals made to break a generator: quotes, line breaks, `;`, `--`, `/*`, `$$`, emoji, 63-byte names, reserved words, mixed case. A generated file must run as written and change nothing else.
- **Ordering.** Cycles (foreign keys both ways, views on views, a function used by a default and a view), and dropping something others depend on.
- **Property check.** Random structures (small, generated) as `from` and `to`; the plan must pass the round trip. A failure prints the pair.
- **Pure unit tests** for the classification and the rename evidence; **e2e** for the tab (pick two sides, select changes, confirm a destructive step, export, the file's content).
- **An independent review of the generator**, before release, like 1.5.2 and 1.6.0 (both found real bugs): it reads the code only, and hunts for a statement that would do more or less than the diff says.

## 8. The screen (milestone M4)

A **Migrations** tab, reached from the diff of the Snapshots tab ("Generate a migration from this comparison") and from the tab bar. Reusing the side pickers already built.

1. **From and To**, with a swap button and the words "make _From_ look like _To_": a snapshot or the live database of any connection, so two environments (staging and production) can be compared.
2. **The plan**: the steps in order, grouped by object, each with its risk badges (a lock, a rewrite, can fail, destroys data, cannot be undone), the one-sentence note, and the SQL (up and down) one click away. A checkbox on each change to leave it out (dependents that would break are said and kept together).
3. **Renames** suggested with their evidence, off until confirmed.
4. **Destructive steps** each need a confirmation before they are in the file.
5. **The summary and the verdict** at the top: counts by risk and the reversibility of the rollback.
6. **The script** (up), the **rollback** (down), and the **warnings** (what was not compared) in tabs; copy and download.

All of it is in memory, in the browser, like the SQL tab: nothing about a plan is saved or sent anywhere; the script is built in the browser from structures the app already read (or in a pure function on the server for the same input, whichever the spike shows is simpler to test; the planner is the same code either way).

## 9. Export (milestone M5)

- **Plain SQL**: `BEGIN; ... COMMIT;`, comments flattened to one line (names can hold line breaks), a header naming what it compares and when, the verdicts, and the warnings.
- **One file with markers** for the common runners: dbmate (`-- migrate:up` / `-- migrate:down`), goose (`-- +goose Up` / `-- +goose Down`).
- **A pair of files** named for Flyway (`V<timestamp>__<name>.sql`, `U<timestamp>__<name>.sql`) and as `up.sql` and `down.sql`.
- **Steps that cannot run in a transaction** (`CREATE INDEX CONCURRENTLY`, a new enum label that is then used) go in a second part, in order, with a comment saying why, and the transactional part is a script of its own.
- The file name uses the clock of the person's browser and a name they give; no database name is used unless they ask.
- A header on every file: "Generated by DataCanvas from a comparison of A and B. Read it before you run it: it contains definitions (views, functions) read from A." A file made from a hostile database holds hostile text, and the definitions of views and functions run when the file is run.

## 10. Security and privacy

- No new route runs SQL, and the planner has no connection: it works on structures. The routes that give the structures exist (`GET /structure`).
- **No rows**, whatever the state of data viewing, like a snapshot.
- The structures include definitions of views and functions, which can hold business logic; they are in memory, and an exported file is a file the person makes. A snapshot already holds the same.
- Generated text is the risk: every name through `quoteIdentifier`, every literal through `quoteLiteral`, every comment line flattened, and a test with hostile names (section 7).
- **Not in this phase, on purpose: applying a migration.** Running a script, even in a transaction that is rolled back to check it, is arbitrary DDL execution. If it is built, it goes through the write service with all four switches, on a local database only, with its own review and decision; this plan makes the generator good enough that it is not needed to trust the output.

## 11. Milestones

Each is red-first, ends with all checks green, and is a commit on one branch. The independent review comes before the release PR, and its findings are fixed in the same PR.

|     | Milestone                                                           | Done when                                                                                                                                                                              |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0  | **Structure gaps and the harness**                                  | The extra fields of section 6 are read (additive, old snapshots still load and compare), and a round-trip harness exists on a real PostgreSQL with one scenario (add a column) passing |
| M1  | **Planner for tables, columns, constraints, indexes, foreign keys** | `planMigration` with ordering, up and down, risk classification, the version choices; the scenario table for these kinds, all round trips green; hostile-name tests                    |
| M2  | **The other objects**                                               | schemas, extensions, types, sequences, views (ordered), functions, triggers, policies, row security, comments; cycles and dependents; scenarios for each                               |
| M3  | **Rename suggestions**                                              | Evidence and the confirmed rename steps; tests that an unconfirmed rename is a drop and an add                                                                                         |
| M4  | **The Migrations tab**                                              | Pick sides, the plan with risks, leave changes out, confirm destructive steps, the three tabs; e2e; axe, dark, phone                                                                   |
| M5  | **Export**                                                          | The four formats, the transaction split, file names; e2e that reads the files; a run of each exported file on a real PostgreSQL (psql) in CI                                           |
| M6  | **Polish, docs, review, release**                                   | README, guide chapter, `SECURITY.md`, threat model, decisions, CHANGELOG, version 1.7.0; the independent review; a PR                                                                  |

Rough size: M0 2 days, M1 4, M2 4, M3 1.5, M4 3, M5 2, M6 2. About 18 days, most of it in M1 and M2, because the tests are the work.

## 12. Risks

| Risk                                                                  | Plan                                                                                                                              |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A generated script is subtly wrong (an order, a missing clause)       | The round trip is the oracle, with data, for every kind of change; a property test over random structures; the independent review |
| The structure reader misses something, so the migration is incomplete | The reader's gaps are fixed in M0, and what is still not read is listed in every migration                                        |
| A hostile database name or definition breaks the generated file       | Quoting everywhere, flattening of comments, hostile-name round trips, a provenance header                                         |
| A rename is guessed wrong                                             | Never automatic; the evidence is shown; off by default                                                                            |
| A destructive step is exported by accident                            | Commented out until confirmed, per step; the summary names them first                                                             |
| Large databases (thousands of tables) make the plan slow              | The planner is linear in the size of the diff; measured in M4 against the 5,000-table fixture                                     |
| Snapshots from older versions lack the new fields                     | They are treated as "not recorded", the migration says which parts it could not plan, never as "none"                             |

## 13. Decisions taken (2026-11-19)

1. **A new Migrations tab**, which the diff in the Snapshots tab links to ("Generate a migration from this comparison"). The two stay one click apart.
2. **Formats:** plain SQL, dbmate markers, goose markers, and a Flyway pair of files (and `up.sql` with `down.sql`). Prisma, Knex, Rails and Alembic are not in 1.7.0.
3. **Rename suggestions are in**, confirm-only, off until the person confirms each one.
4. **Owners and grants are out.** Every migration lists them under "not compared".
5. **Applying a migration is not in this phase**, nor checking one in a rolled-back transaction. The generator is made trustworthy by the round-trip tests instead.
6. **PostgreSQL 12 to 18**, the same range as the rest of the product.
