---
title: Snapshots and diff
description: How a database's structure is captured deterministically, stored, imported, and compared in the browser.
---

## The structure model

`packages/database-core/src/structure.ts` defines `DatabaseStructure` (schemas, tables with their columns,
constraints and indexes, and the foreign keys) and `buildStructure`, which **sorts everything** so the same
database always produces the same value. It deliberately leaves out the planner's row estimates (they change
with every vacuum) and never contains rows. A structure also holds `objects` (views, types, sequences,
functions, triggers, extensions, policies) and, since 1.7, sparse `ddl` detail used by migrations. A
structure that never recorded objects or ddl has `null` there, which is **not** the same as "none".

## The diff

`diff.ts` holds the pure `diffStructures(before, after)`:

- Tables matched by `schema.name`; columns, constraints and indexes by name; foreign keys by (source table,
  constraint name), compared once as relationships.
- Column position is ignored. **No rename detection.**
- A changed item lists exactly which fields changed as readable text, so no screen needs to know each kind's
  shape. `diffToMarkdown` writes the same result as a report.
- Objects are matched by what identifies each kind (a function by schema, name and argument list, so overloads
  are separate; a trigger or policy by table and name). If either side has `objects: null`, objects are **not
  compared**, and `SchemaDiff.objectsCompared` records that because `isEmpty` alone cannot tell "nothing
  differs" from "not looked at".
- The comparison works on raw values (`["a, b"]` differs from `["a", "b"]`), treats no value and an empty
  string as equal, and keeps two items with the same key (paired in order) instead of silently replacing one.

Because the diff is pure and the app already bundles `database-core` for the browser, **it runs in the
browser**: the server only provides structures. Any two sides work (snapshot or live database of any
connection), so comparing two databases needs no extra endpoint.

## Capture and storage

- `ConnectionService.captureStructure` reads the schemas, the tables of each (eight schemas at a time), their
  details in batches of at most 500 and the foreign keys, then the objects. It refuses more than **5,000
  tables** (`snapshot_too_large`). The browser only says "snapshot this connection" and may give a name, so a
  snapshot is **never taken from the browser's word**.
- `SnapshotService` takes, lists, loads, deletes, exports and imports snapshots. `SnapshotStorage` writes
  `snapshots/<id>.json` with the same rules as workspaces (owner-only, atomic, ids that can never be a path,
  damaged files skipped and left alone). At most **100** are kept; the limit check and file write happen under
  one lock (`putIfRoom`), and a test fires more saves than there is room for and counts the files.
- The file format is versioned (`datacanvas-snapshot`, currently version 2). The 1→2 migration sets `objects`
  to `null`. Unknown keys are refused, every string and list has an upper bound (at most 10,000 of each object
  kind), and an import always gets a new id, because an imported file is untrusted.

| Method and path                       | Purpose                                           |
| ------------------------------------- | ------------------------------------------------- |
| `GET /api/connections/:id/structure`  | The live structure, nothing saved                 |
| `POST /api/connections/:id/snapshots` | Take a snapshot (`{ name? }`), 201 with a summary |
| `GET /api/snapshots`                  | Summaries, newest first                           |
| `GET /api/snapshots/:id` / `DELETE`   | The full snapshot / delete                        |
| `GET /api/snapshots/:id/export`       | Download `.snapshot.json`                         |
| `POST /api/snapshots/import`          | Import file content as a new snapshot             |

## Known caveat

A snapshot is **not atomic**: schemas, tables, details, foreign keys and objects are separate reads, so one
taken while a migration runs can mix states. Reading everything in one repeatable-read transaction would need
the adapter to expose one; it is not done.

---

**Sources:** [`packages/database-core/src/structure.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/database-core/src/structure.ts),
[`packages/database-core/src/diff.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/database-core/src/diff.ts),
[`apps/web/lib/server/snapshot-service.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/snapshot-service.ts),
[`apps/web/lib/server/storage/snapshot-storage.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/storage/snapshot-storage.ts),
[`packages/shared-types/src/snapshots.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/shared-types/src/snapshots.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/architecture.md) (Schema snapshots and diff). The mention of
`ddl` in the structure follows `database-core/src/ddl.ts` (header says a structure that never recorded it has `ddl: null`).
