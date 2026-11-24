---
title: Persistence
description: How profiles, workspaces and snapshots are stored as versioned files with atomic writes, per-file locks, and path-safe ids.
---

DataCanvas persists three kinds of data as JSON files in the data folder (`~/.datacanvas`, or
`DATACANVAS_HOME`):

```text
connections.json          { format, schemaVersion, profiles: [...] }
workspaces/<id>.json      { format, schemaVersion, id, name, …, canvas }
snapshots/<id>.json       { format: "datacanvas-snapshot", schemaVersion: 2, … }
run.json                  { pid, port, token, version, writes }   (running instance, deleted on exit)
mcp.json                  { pid, port, token }                     (token of /mcp for the bridge, 0600, deleted on exit)
```

The data folder is created owner-only (`0700`) and files are `0600`. Storage classes live in
`apps/web/lib/server/storage/` (`profile-storage`, `workspace-storage`, `snapshot-storage`, `atomic-file`,
`data-dir`).

## Why files, not IndexedDB

IndexedDB belongs to a browser origin **including its port**: starting on 4748 instead of 4747 would silently
hide everything. Files in the home folder do not depend on the port.

## Atomic writes

`writeFileAtomic` writes the complete new content to a temporary file in the **same folder**
(`.name.<random>.tmp`, created exclusively with mode `0600`), flushes it with `fsync`, then `rename`s it over
the real file. A rename is one operation, so a reader or later run sees the whole old file or the whole new
one, never half. A test hammers one file with 40 concurrent writers while a reader parses continuously. A
failed write removes its temporary file and leaves the original intact. `KeyedMutex` serialises
read-modify-write sequences per file so two requests cannot overwrite each other's change.

## Versioned formats

Every file has a `format` and `schemaVersion` (`shared-types/src/versioned-file.ts`). `migrateToCurrent`
upgrades by running `migrations[n]` (version n → n+1) in order, **then** validates against the current
schema, so the rest of the code only ever sees one layout. A file from a **newer** release is refused with a
clear message. A test uses a pretend three-version format to prove the chain works.

To change a format in a future release (the notes' example: v2 renames `expanded` to `collapsed`), bump the
current version constant, add a migration entry that rewrites each node, change the saved schema, and add a
test with a real v1 file. Old files open automatically and are written back as v2 on the next save.

Existing real migrations: saved connections moved to version 2 to add `dataAccess` (existing profiles get
`false`); snapshots moved to version 2 to add `objects` (set to `null` for old snapshots).

## Workspace save and load

```text
SAVE  canvas store nodes → serializeCanvas() keeps { schema, name, x, y, expanded } (positions to 0.1)
      + viewport {x,y,zoom} → PUT /api/workspaces/:id (Zod) → server stamps id and times → writeFileAtomic

LOAD  GET /api/workspaces/:id → parseWorkspaceFile(): migrate, then validate
      → restoreWorkspace(): list each schema once, load structure of tables that exist (one bulk request)
      → canvasStore.restore(nodes, viewport); tables that no longer exist are kept but flagged `missing`
```

Selection, measurements, metadata and edges are not saved; they are recomputed.

**Autosave** (`createAutosaver`): each change restarts an 800 ms timer; before writing it compares a
signature of the would-be document with the last saved one, so selecting or measuring never writes. One save
per connection at a time; a change during a save triggers a follow-up. It runs only for connections linked to
a saved profile. Switching or creating a workspace flushes the current one first.

## Safety properties

- An id becomes a file name in **exactly one place**; the id pattern allows no path characters, and tests try
  `../../etc/passwd`, `..`, `a/b`, NUL, over-long and empty ids on every storage operation.
- Damaged files: a workspace file is skipped when listing (never deleted); `connections.json` is moved aside
  and a fresh one started; a newer-release file is refused untouched.
- Error messages never include paths, file content or the system's message.
- Limits: 2,000 nodes per workspace, 1 MB per workspace request, 500 workspaces, 100 profiles, 100 snapshots,
  coordinates within ±10 million, zoom 0.01 to 10.
- Snapshot saving checks the limit and writes under one lock (`putIfRoom`).

## HTTP surface

`GET /api/profiles`, `DELETE /api/profiles/:id` (also deletes that profile's workspaces),
`POST /api/connections` with `remember` or `profileId`, `POST /api/connections/:id/save`,
`GET /api/workspaces[?profileId=]`, `GET/PUT/DELETE /api/workspaces/:id`,
`GET /api/workspaces/:id/export`, `POST /api/workspaces/import[?profileId=]`, and the snapshot routes. See the
[HTTP API reference](/reference/api/).

---

**Sources:** [`apps/web/lib/server/storage/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web/lib/server/storage),
[`packages/shared-types/src/versioned-file.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/shared-types/src/versioned-file.ts),
[`apps/web/features/workspaces/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web/features/workspaces),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md) (Phase 8).
Limit figures other than `MAX_PROFILES`, `MAX_WORKSPACES` and `MAX_SNAPSHOTS` are taken from `docs/architecture.md`.
