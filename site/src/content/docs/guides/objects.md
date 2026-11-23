---
title: Database objects
description: Views, types, sequences, functions, triggers, extensions and row-level-security policies, read as definitions and settings only.
---

The **Objects** tab shows what is in the database besides tables. There is one sub-tab per kind with a
name filter, and lists show the first 100 entries with an option to show the rest. This tab reads
**definitions and settings only**: no table rows and no sequence values.

| Kind                               | What you see                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Views** (and materialized views) | The query as the server prints it, the comment, **what it reads**, and which views read it. Names link to the table on the canvas.                                    |
| **Types**                          | Enums with their values in declared order, domains (base type, default, rules), composite types and range types.                                                      |
| **Sequences**                      | Type, start, step, limits, cache, cycle, and the column that owns it. Numbers are shown as text; the current value is never read.                                     |
| **Functions** (and procedures)     | Argument list (which tells overloads apart), result, language, volatility, whether it runs with its owner's rights, comment and the full definition.                  |
| **Triggers**                       | Timing, events, row or statement, the function it calls, enabled or disabled, definition.                                                                             |
| **Extensions**                     | Name, version, schema, description.                                                                                                                                   |
| **Policies**                       | Row-level security per table, with a warning when security is **on but no policy allows any row**, and when policies exist but security is **off** (they do nothing). |

## What is left out, deliberately

- System schemas.
- Objects that **belong to an installed extension** (so installing `pgcrypto` or PostGIS does not add
  hundreds of functions you did not write); the extension itself is listed.
- Functions the server made as part of something else (for example a range type's constructors).
  Sequences of identity columns are kept.
- The row type every table has, array types, and internal triggers (foreign-key enforcement). A
  partitioned table's triggers are shown once, not once per partition.
- Definitions longer than 20,000 characters are cut; the cut text ends with its full length and a
  fingerprint of the whole text so that two long definitions that differ only after the cut still
  compare as different in a [snapshot comparison](/guides/snapshots/).

## Not covered

Aggregates and window functions (no body of their own), event triggers, rules, publications and
subscriptions, foreign data wrappers and servers, collations, operators, casts, roles and grants,
comments on objects other than views, types, functions and extensions, and dependencies of functions on
tables (PostgreSQL does not record what a function body reads).

The queries are written for **PostgreSQL 12 and newer**.

---

**Sources:** [`packages/postgres-adapter/src/introspection/objects.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/postgres-adapter/src/introspection/objects.ts),
[`apps/web/features/objects/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web/features/objects),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md) (Database objects).
