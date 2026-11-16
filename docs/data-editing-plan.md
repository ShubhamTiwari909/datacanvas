# Plan: editing rows and designing tables

Status: **proposal, nothing built.** This builds on `docs/data-viewer-plan.md` (the read-only data viewer) and is the "editing" work that plan deliberately left out (its section 13). The decisions already made are in section 3; the open ones, each with a recommendation, are in section 13. Version 1.4.0 also carries a small, independent feature, **searching tables from the sidebar** (`docs/sidebar-table-search-plan.md`), which is not part of this plan's milestones.

## 1. Goal

Let a person, from inside DataCanvas and without writing SQL:

- **change rows**: update, insert and delete, one row at a time;
- **create tables** by defining the schema in a form, and **alter existing tables** (add, rename and change columns, constraints and indexes, and drop with extra confirmation).

Every change is previewed as the exact statement that will run, runs in one transaction, and can only be done on a database the person has deliberately unlocked for writing.

## 2. Non-goals

- A SQL console or any way to run text typed by the user. "No arbitrary SQL" stays. The client sends a structured **operation** (JSON); the server turns it into SQL.
- Bulk operations: no multi-row update, no "delete where", no import of CSV or JSON.
- Migrations as files, schema version control, or applying a change to several databases.
- Undo. A committed change is committed. The design prevents mistakes instead of promising to reverse them.
- Writing to remote databases (decision S3).
- Roles, grants, extensions, functions, triggers, views and policies. Only tables, columns, constraints and indexes.

## 3. Decisions already made

Made by the requester, 2026-11-16:

- **S1. Row changes include insert and delete**, not only update.
- **S2. The table builder both creates new tables and alters existing ones.**
- **S3. Writes only on a local database.** A remote or production database stays read-only whatever else is switched on. _Reading of "yes, only local db":_ writes are allowed only when the connection is local and blocked on everything else. Section 6.1 says what "local" can and cannot prove; please confirm this reading.
- **S4. Warn when the connected database role has more rights than the task needs.**

## 4. What changes, and what must not

Today DataCanvas is read-only by construction: every query runs in a read-only transaction and the adapter interface has no way to write. After the data viewer it also reads rows, opt-in. This feature removes the read-only guarantee **for databases where writes are unlocked**, and nowhere else.

| Promise                                        | After this feature                                                                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only by default, everywhere               | **Stays the default.** Writes exist only when DataCanvas was **started** with `--enable-writes`, the database is local, and the person unlocks that connection (section 6.1). |
| Every query runs in a read-only transaction    | **Changes, narrowly.** Reads still do. A write runs in a separate read-write transaction that exists only inside the write path.                                              |
| No arbitrary SQL, ever                         | **Stays.** The server builds the statement from a validated operation, from catalog-checked names, an allow-list of types and defaults, and bound parameters.                 |
| Nothing leaves the machine                     | **Stays.**                                                                                                                                                                    |
| Rows never logged, saved, cached or in errors  | **Stays, and extends to writes:** values of an edit are never logged, saved or echoed in an error; the session history records operations and column names, never values.     |
| A read-only database role is the safest choice | **Stays true and is now actively encouraged** by the role warning (section 6.2).                                                                                              |

The README, `SECURITY.md`, the threat model, the CLI help and the in-app wording change **with** the feature (section 12).

## 5. Guardrails (the rules the design is held to)

1. **Writes are off unless the process was started with `--enable-writes`.** A web page or another program that reaches the API with the session token cannot turn writes on, because the switch is not in the API. This is stronger than a toggle in the UI.
2. **Local databases only** (S3), then **per connection and per session**: the person unlocks writes for one connection, by typing its database name, every time it is connected. The unlock is never remembered in a saved profile.
3. **Writing requires data viewing** (the viewer's opt-in) to be on for the connection, because editing is done on rows the person can see.
4. **Operations, not SQL.** A request carries `{ kind: "update_row", table, key, changes, expected }` and similar; a strict schema rejects any `sql`, `where` or free-text field. Identifiers come from the catalog and are quoted; every value is a bound parameter cast to the column's own type.
5. **Preview then apply.** `preview` returns the exact SQL, the effect and the warnings, and a single-use `previewId` (held in server memory for five minutes). `apply` takes only that id and executes exactly what was previewed.
6. **One transaction, asserted.** A row edit must affect **exactly one row** or it rolls back. A DDL change is one transaction. Nothing is auto-committed in pieces.
7. **Fail fast, never queue.** `lock_timeout` is short (3 seconds), so a change that would wait behind a long transaction, and block every query behind it, fails with a clear message instead.
8. **No `CASCADE`, ever.** A drop that has dependents fails and says what depends on it.
9. **Bounded:** one write at a time per connection, a statement timeout, limits on columns per table and on name length.
10. **Fixed error messages.** A PostgreSQL error can contain a row value ("duplicate key value violates unique constraint ... Key (email)=(a@x.test) already exists"). Errors are mapped from the SQLSTATE code to fixed text (section 6.4), never passed through.

## 6. Design

### 6.1 Enabling writes: three independent layers

1. **Process switch.** `datacanvas --enable-writes` (a new `parseArgs` option in `packages/cli/src/index.ts`). The launcher passes it to the web server as `DATACANVAS_ENABLE_WRITES=1`, the same way it already passes the session token, and `readSecurityConfig` exposes it as `writesEnabled`. Without it, every write route answers `writes_not_enabled` and the UI says how to start DataCanvas with writes. Nothing in the API can change it.
2. **Local database.** A connection may be unlocked only if its host is **loopback** (`localhost`, `127.0.0.0/8`, `::1`). Anything else stays read-only, with an explanation.
3. **Per connection, per session.** A "Writes" switch on the connection asks the person to type the database name. The server then records `writeUnlocked` in the registry entry (memory only). Disconnect, reconnect or restart clears it.

**What "local" can and cannot prove.** The host in the connection is what the person typed. A tunnel (`ssh -L`) or the Cloud SQL Auth Proxy, which this project's own guide recommends, listens on `127.0.0.1` and forwards to a **remote or production** database, so such a connection looks local. The rule keeps out the common accident (a remote host typed into the form) but is not proof. Two things reduce the risk, and neither can remove it: the unlock dialog shows the address the **server** reports (`inet_server_addr()`) next to the database name and asks the person to confirm it is not production; and a red "Writes on" badge stays visible. A database in Docker with a published port reports a private address and is legitimately local, so the server address is **shown, not enforced** (decision D4).

### 6.2 Role check (S4)

A new read-only adapter call, `getRoleInfo()`, reads what the connected role can do: superuser, `CREATEDB`, `CREATEROLE`, `BYPASSRLS`, membership of the predefined write roles (`pg_write_all_data`, `pg_execute_server_program`, `pg_write_server_files` and similar), `CREATE` on the database and on each schema, and a count of tables on which it holds `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` (through `has_table_privilege`, one bounded catalog query, no data).

What counts as "more than needed" depends on the mode:

| Mode                    | Needs                       | Warns when the role                                                                                   |
| ----------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| Read-only (the default) | `SELECT` and catalog access | can write to any table, can create objects, or is a superuser: "use a read-only role for browsing"    |
| Writes unlocked         | the rights the changes need | is a superuser, can create roles or databases, bypasses row-level security, or can write server files |

The warning is information with a plain explanation and a suggested fix, never a block: some people legitimately connect as the owner of a local development database. It appears on the connection and in the unlock dialog.

### 6.3 The write path

- **A separate capability.** The existing `DatabaseAdapter` interface stays exactly as read-only as it is. A new `WritableAdapter` interface adds `applyChange(change)`; only the PostgreSQL adapter and the mock implement it, and the service reaches it only after all three layers of 6.1 pass. An architecture test (like the existing ones in `tests/architecture.test.ts`) fails if any other file imports it.
- **`withWriteTransaction`**, next to `withReadOnlyTransaction`: `BEGIN` (read-write), `SET LOCAL lock_timeout`, `SET LOCAL statement_timeout`, the work, `COMMIT`; `ROLLBACK` on any error or failed assertion. It uses its own pool client, never one of the read-only sessions.
- **Preview store.** An in-memory map from `previewId` to the validated operation, the connection and an expiry. Single use. Cleared on disconnect.

### 6.4 Row changes (S1)

**Which tables.** A table can be edited if it has a **primary key**, or a unique non-partial index whose columns are all `NOT NULL`: the same key the viewer pages by. Tables without one stay read-only (a row cannot be addressed safely). Views, materialized views and foreign tables are not editable. Partitioned tables are editable (PostgreSQL routes the row).

**Update.** The operation names the table, the row's key values and the changed columns with their new values as text. The server builds

```sql
UPDATE "s"."t" SET "a" = CAST($1 AS <type of a>), "b" = ...
WHERE "k" = CAST($n AS <type of k>)
  AND "a" IS NOT DISTINCT FROM CAST($m AS <type of a>)   -- what the person saw
RETURNING 1
```

The second `WHERE` part is the **conflict check**: the row is changed only if the columns being changed still hold the values the person saw. Zero rows affected means someone else changed or deleted it ("this row changed since you loaded it"), and nothing is written. More than one row cannot happen with a key, but is asserted anyway and rolls back.

**Insert.** The person fills a form built from the column list. Each column can be left to its default. `GENERATED ALWAYS` identity and generated columns are not editable; `GENERATED BY DEFAULT` identity can be set or left to the default.

**Delete.** By key, after a confirmation that shows the row's key, and a count of what references it from the foreign keys already known (`RelationshipInfo`, including each `ON DELETE` action): "2 other tables reference this row; `orders.user_id` will cascade". Deleting a row that cannot be deleted because of a restrict action fails with the constraint's name.

**Typed values.** Every value travels as text and is cast in the database to the column's declared type (the type text comes from `format_type` in the catalog, so it is already valid, quoted SQL). The browser validates for convenience (numbers, dates, JSON); the database is the authority. `NULL` and the empty string are separate choices in the form. Cells of types with no useful text editing (`bytea`) are read-only in the first version.

**Things the person must be told before applying** (computed from catalog data DataCanvas already reads): triggers on the table that will run (`getObjects`), row-level security that may hide the row, and, for a key column, the incoming foreign keys and their `ON UPDATE` action.

**Fixed errors by SQLSTATE** (no database text): `23505` "a row with the same value already exists (constraint _name_)"; `23503` "this breaks a foreign key (_name_)"; `23502` "_column_ cannot be empty"; `23514` "a check rule failed (_name_)"; class `22` "the value is not valid for _column_ (_type_)"; `55P03` "the table is locked by another session, try again"; `40001`/`40P01` "the database asked for a retry"; `42501` "the database role cannot change this table". Constraint and column names are structure, not row values, so they may appear; values never do.

### 6.5 Creating a table (S2)

A form with a live preview of the `CREATE TABLE` statement.

- **Name and schema:** validated (at most 63 bytes, not empty, the schema must exist and the name must not), always quoted.
- **Columns:** name, type, nullable, default. **Types come from an allow-list** (`smallint`, `integer`, `bigint`, `numeric(p,s)`, `real`, `double precision`, `boolean`, `text`, `varchar(n)`, `char(n)`, `date`, `time`, `timestamp`, `timestamptz`, `interval`, `uuid`, `json`, `jsonb`, `bytea`, `inet`, and arrays of these), with parameters validated. Identity columns (`GENERATED ... AS IDENTITY`) replace `serial`.
- **Defaults are structured, not free text:** none; a literal of the column's type (cast in the database); `now()`; `current_date`; `gen_random_uuid()` (built in from PostgreSQL 13; on 12 it is offered only when it exists, checked in `pg_proc`); `true`/`false`; an identity.
- **Constraints:** primary key (one or several columns), unique, and foreign keys chosen **from existing tables and columns** (types must be compatible; `ON DELETE` and `ON UPDATE` choices). **Check constraints are not in the first version**: a check is an arbitrary expression, and a structured subset (column, comparison, literal) can be added later.
- **Comment** on the table and columns.
- Running it is one transaction; on success the schema tree and canvas refresh.

### 6.6 Altering an existing table (S2)

Operations, each previewed as its exact statement with warnings:

| Operation                                    | Notes                                                                                                                                                                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add column                                   | Same column definition as 6.5. A `NOT NULL` column without a default on a table with rows fails; the preview says so.                                                                                                                    |
| Rename column, rename table                  | Warns about views, functions and code that use the old name (views are known from `getObjects`).                                                                                                                                         |
| Change column type                           | Only where PostgreSQL has an implicit or assignment cast (`pg_cast`), so no `USING` expression is needed; otherwise refused with an explanation. Rewrites the table and takes a lock: the preview says so, with the estimated row count. |
| Set or drop `NOT NULL`, set or drop default  | `SET NOT NULL` scans the table: warned.                                                                                                                                                                                                  |
| Add or drop primary key, unique, foreign key | Adding a foreign key validates every row: warned.                                                                                                                                                                                        |
| Create or drop index                         | `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, so the first version creates plain indexes (a write lock) and says so.                                                                                                |
| **Drop column, drop table**                  | Destructive. Needs the table name typed. Lists every view, foreign key and index that depends on it, and **refuses** when any exists (no `CASCADE`).                                                                                     |

Every DDL change runs under a short `lock_timeout` and an `ACCESS EXCLUSIVE`-aware warning: most `ALTER TABLE` forms take that lock, which blocks all reads of the table until the change commits.

### 6.7 What the person sees

- **Unlock dialog:** type the database name; shows the server address, the role warnings and the plain sentence "Changes are committed immediately and cannot be undone."
- **Writes badge:** red, on the connection and wherever editing is offered, with a "Lock writes" button.
- **In the data viewer:** with writes on, a cell opens an editor; a row has Edit and Delete; the toolbar has "Add row". Nothing is edited in place without the preview step.
- **Preview dialog:** the statement as text (copyable), a table of old and new values, the warnings (triggers, cascades, locks, dependents), and an Apply button that is disabled until the person ticks that they have read it for destructive operations.
- **New table** (sidebar and schema menu) and **Edit structure** (table details) open the builder.
- **Session history:** a list of changes made since connecting: the operation, the table, the column names, the time and the outcome. For DDL it also shows the SQL. **Never values.** Memory only.

## 7. Changes by layer

| Layer                       | Change                                                                                                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli`              | `--enable-writes` option and help text; passes `DATACANVAS_ENABLE_WRITES`; prints a clear notice at start when writes are enabled.                                                                                                                                |
| `packages/database-core`    | Models `Change` (strict union of operations), `ChangePreview`, `RoleInfo`; a `WritableAdapter` interface; `getRoleInfo()` on the read-only adapter; the allow-lists of types and defaults; SQLSTATE-to-message mapping.                                           |
| `packages/postgres-adapter` | `introspection/role-info.ts`; `writes/` (statement builders per operation, `withWriteTransaction`, row-count assertions); tests of every statement's text and parameters.                                                                                         |
| Mock adapter                | An in-memory implementation of the writable interface over the sample data, so services and routes are tested without a database.                                                                                                                                 |
| `packages/shared-types`     | Strict request and response schemas for operations, previews and role info; new error codes (`writes_not_enabled`, `writes_not_allowed_here`, `write_not_unlocked`, `preview_expired`, `row_changed`, and the fixed-message codes of 6.4).                        |
| `apps/web` server           | `SecurityConfig.writesEnabled`; `writeUnlocked` and the preview store in the registry; `WriteService`; routes under `/api/connections/:id/writes/` (`unlock`, `lock`, `preview`, `apply`) and `role`; all inside `handleRoute`, all `no-store`, JSON bodies only. |
| `apps/web` UI               | Unlock dialog, badge, editors, preview dialog, table builder, session history, role warnings.                                                                                                                                                                     |
| Docs and tests              | Sections 9 and 12.                                                                                                                                                                                                                                                |

## 8. Security and privacy analysis

New capability: **changing and destroying data and structure.** The previous worst case of a stolen session token was reading; this adds writing, but only on a local database that was started in write mode and unlocked by the person.

| Risk                                             | Mitigation                                                                                                                                              | Left over                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A web page or local program calls a write route  | Existing Host, Origin, `Sec-Fetch-Site` and token checks; `--enable-writes` at start-up (not reachable from the API); local-only; per-connection unlock | Someone holding the token, on a machine where writes were enabled and a connection unlocked, can write |
| Writing to production by mistake                 | Local-host rule; typed database name; server address and red badge; role warning                                                                        | A tunnel or proxy on `127.0.0.1` to a remote database looks local (section 6.1)                        |
| SQL injection through names or values            | Operations are strict JSON with no SQL field; identifiers from the catalog and quoted; values bound and cast; types and defaults from allow-lists       | None known                                                                                             |
| Applying something other than what was previewed | Single-use `previewId`; `apply` takes only the id; the operation is held on the server                                                                  | None known                                                                                             |
| Overwriting someone else's newer change          | Conflict check on the values the person saw; exactly-one-row assertion                                                                                  | Two people editing different columns of one row do not conflict, which is correct                      |
| Data loss from a delete or a drop                | Confirmation with referenced-by counts; typed table name for drops; no `CASCADE`; transactions                                                          | A committed delete cannot be undone                                                                    |
| Taking the database down with a lock             | `lock_timeout` of 3 seconds; lock warnings; one write at a time                                                                                         | A long-running `ALTER` that has the lock still blocks others until it finishes                         |
| Values leak through errors, logs or history      | SQLSTATE-mapped fixed messages; values never logged or recorded; history holds column names only                                                        | The browser's own memory                                                                               |
| A role with far more rights than needed          | Role check and warnings (6.2)                                                                                                                           | A warning can be ignored                                                                               |
| Writes enabled by habit                          | A notice at every start with `--enable-writes`; the unlock is per connection and per session and is never saved                                         | A person who always starts with the flag                                                               |

## 9. Testing plan

- **Unit:** every statement builder (identifier quoting, casts, parameter order, the conflict check, the exactly-one-row assertion); the strict operation schemas (a `sql`, `where` or unknown key is refused); the allow-lists; SQLSTATE mapping; role-warning rules; the preview store (single use, expiry, cleared on disconnect).
- **Adapter integration (real PostgreSQL), on the awkward-schema fixture:** update, insert and delete with quoted, Unicode, reserved-word and 63-byte names; composite keys and keys that are long text; every type in the allow-list round-tripped; `NULL` against the empty string; conflict detected when another session changed the row; deleted-meanwhile; unique, foreign-key, not-null and check violations return the **fixed** messages and never the value (a test makes PostgreSQL's own message contain a distinctive value and asserts it is absent); triggers and cascades fire and are reported; a table without a key is refused; a partitioned table; row-level security; `lock_timeout` (a second session holds a lock, the change fails fast and writes nothing); full rollback on any failed assertion; each DDL operation including refusal of `CASCADE`-needing drops; `gen_random_uuid` on 12 against 13 and newer.
- **Security rule tests (`tests/` style):** every write route is guarded and refuses without `--enable-writes`, for a non-local host, for a locked connection and without data viewing; no route accepts SQL; only the write service imports `WritableAdapter`; no write code logs values; the session history never holds values; a snapshot, a structure capture and every read path never call a write.
- **Version matrix:** the adapter write tests on PostgreSQL 12 to 18 through `npm run test:pg-matrix`.
- **End to end (Playwright), against a throwaway database:** start with and without `--enable-writes`; unlock with a wrong and a right name; edit, insert and delete a row; a conflict; create a table; alter it; a refused drop; the badge and lock; the role warning for a superuser connection.

## 10. Milestones

Sizes are relative (S, M, L), not time estimates. **Prerequisite: the data viewer (its M1 to M3) is built**, because editing reuses its key discovery, row display and paging.

|     | Milestone                                                                                                                                | Size | Done when                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------- |
| E0  | **Decisions and wording:** settle section 13, confirm S3, agree Appendix A                                                               | S    | Open decisions answered, wording agreed                                                                        |
| E1  | **Plumbing:** CLI flag, config, local rule, `getRoleInfo` and warnings, `WritableAdapter`, `withWriteTransaction`, preview store, unlock | M    | Without the flag or the unlock, no write can run; role info passes on 12 to 18                                 |
| E2  | **Row changes, server and adapter:** update, insert, delete, conflict check, fixed errors, tests on 12 to 18                             | L    | Every case in section 9 passes; no value reaches a log or an error                                             |
| E3  | **Row changes, UI:** unlock dialog, badge, editors, preview, history, Playwright                                                         | L    | The end-to-end flow passes; checked by eye in light and dark                                                   |
| E4  | **Create table:** builder, preview, allow-lists, tests                                                                                   | M    | A table created from the form matches what was previewed                                                       |
| E5  | **Alter table:** operations, lock warnings, dependents, refusals, tests                                                                  | L    | Every operation previewed and applied; destructive ones refused when dependents exist                          |
| E6  | **Release:** docs, changelog, minor version, publish checklist                                                                           | S    | Release gate green; version bumped (1.4.0 suggested, after 1.2.0 for the viewer and 1.3.0 for sort and filter) |

Each milestone ends with `npm run check`, the browser tests and the tarball test, and is a separate commit.

## 11. Risks of the project itself

- **Trust.** "Safe to point at anything" is the pitch. Mitigation: read-only stays the default, writes need a start-up flag, a local database and a per-connection unlock, and the wording is honest about what "local" cannot prove.
- **Scope creep toward an admin tool.** Bulk edits, a SQL box, imports, migrations. Mitigation: section 2 names what is out; each addition needs its own decision.
- **Under-estimating DDL.** Locks, rewrites, dependents and version differences are where tools hurt people. Mitigation: warnings computed from catalog data, `lock_timeout`, no `CASCADE`, the matrix, and a conservative first version (no checks, no `USING`).
- **A privacy regression later:** logging or saving a value. Mitigation: tests that fail if values reach logs, files, errors or history.
- **A false sense of safety from the local rule.** Mitigation: the typed name, the server address, the badge, and saying so in the documentation.

## 12. Documentation to update (in the same change)

- `README.md` and `SECURITY.md`: the read-only statements now say "by default"; what writes are, how to enable them, that the database role matters.
- `docs/threat-model.md`: new capability, attackers and residual risks (section 8).
- `docs/getting-started.md`: starting with `--enable-writes`, unlocking, editing, the role warning.
- `docs/architecture.md` and `docs/decisions.md`: the design and one decision per decision in sections 3 and 13.
- The CLI `--help` text and the start-up notice.
- `CHANGELOG.md`, and the in-app wording that says DataCanvas never changes your database (the connect dialog note and the data viewer's wording).
- Per-feature statements such as "this tab reads no table rows" stay true and are unchanged.

## 13. Open decisions

For each: the question, the options, and a recommendation.

1. **Drop column and drop table: in the first release?** (a) yes, behind the typed name and the dependents check; (b) no, later. _Recommendation: (a), in E5 only, refused whenever dependents exist._ Without them "alter" is half a feature, and the guardrails make them safe enough.
2. **Session history: memory only, or also a file?** _Recommendation: memory only_ (no values are recorded either way, but a file is one more thing to protect and to document).
3. **Timeouts.** _Recommendation: `lock_timeout` 3 seconds for everything, `statement_timeout` 15 seconds for row changes and 60 seconds for DDL._
4. **Is "local" only the host, or also the server's reported address?** (a) host only; (b) also require a loopback server address. _Recommendation: (a), and show the address._ (b) would block Docker and every local database behind a port mapping, while a proxy to production can still be made to look right.
5. **Type changes that need a `USING` expression.** _Recommendation: refused in the first version_ (they need an arbitrary expression); revisit with a structured subset.
6. **The start-up switch: a flag or an environment variable?** _Recommendation: the flag `--enable-writes` only_, so that it is visible in the command that started DataCanvas and in the process list. An environment variable is easy to forget in a shell profile.
7. **Is the unlock remembered in a saved profile?** _Recommendation: never._
8. **Does writing require data viewing on?** _Recommendation: yes_ (guardrail 3).
9. **Check constraints and `CREATE INDEX CONCURRENTLY`.** _Recommendation: neither in the first release._
10. **Version number.** _Recommendation: 1.4.0_, after the viewer's 1.2.0 and sort and filter's 1.3.0 (`docs/data-sort-filter-plan.md`, decision 7).

## Appendix A. Wording to agree in E0

Drafts, to be refined and then used when the feature ships; not in the live documents yet.

**README, "Your database, your machine, your control":**

> - DataCanvas **never changes your database unless you start it with `--enable-writes`**, the database is on your own machine, and you unlock writes for that connection by typing its name. Even then there is no way to run your own SQL: you edit rows and design tables through forms that show the exact statement first.

**CLI `--help` line and start-up notice:**

> `--enable-writes   Allow editing rows and changing table structure on local databases (off by default)`
>
> Writes are enabled. Changes are committed immediately and cannot be undone. Connect with a role that can only do what you need.

**Unlock dialog:**

> Allow changes to **_dbname_** on **_address_**? Changes are committed immediately and cannot be undone. Type the database name to confirm, and make sure this is not a production database.

**Role warnings:**

> - Read-only mode: "This database role can change data. For browsing, a read-only role is safer."
> - Writes unlocked: "This role is a superuser. It can do far more than editing tables. A role that owns only this database is safer."

**Fixed error for a database that is not local:**

> Writes are only available on a database running on this machine. This connection stays read-only.
