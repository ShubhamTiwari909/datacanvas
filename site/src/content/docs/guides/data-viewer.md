---
title: Viewing table rows
description: Switch on data viewing per connection, page through rows read-only, sort, filter, hide sensitive columns and blur values.
---

By default DataCanvas reads **only the structure** of your database. To see the rows of a table, switch
on **Allow viewing table data** for that connection: tick it in the connect dialog, use the switch beside
the connection in the left list, or press the button in a table's **Data** section. It is **off for every
new connection**, a badge shows when it is on, and a saved connection remembers your choice (you still
enter the password again after a restart).

Anyone holding the session token can switch data viewing on, so treat the printed link like a password.

## What you get

- **One page of rows at a time, read-only.** 50 rows by default (25, 50, 100 or 200), **Previous** and
  **Next**, and an estimate of the table's size (never a `count(*)`, which would scan the table).
- **Order.** Rows come in primary-key order, or in the order of a suitable unique index when there is no
  primary key. A table with no usable key has no guaranteed order and can be paged only through its first
  **10,000 rows** (it says so); so can a materialized view.
- **Values are text.** `NULL` (italic) is never confused with the empty string ("(empty)"). A value
  longer than 200 characters is cut in the grid; click it, or press **Enter**, to read up to its first
  2,000 characters with a **Copy** button. Wider tables show the first 100 columns and say so.
- **Keyboard use.** One cell is a tab stop; arrows, Home, End, Page Up and Page Down move between cells.
- **Row-level security.** A note appears only when RLS applies to your role: the database decides which
  rows you may read.
- **Choose rows to export.** Every grid of a table with a key has a checkbox on each row; with rows chosen,
  **Export chosen** writes just those (up to 500). See [Export](/guides/export-json-validate/).
- **Blur values.** A switch blurs every value in the grid and the value dialog, for screen sharing. It
  changes only how values look.

## Hidden columns

A column whose name looks sensitive (`password`, `token`, `secret`, `api_key` and similar) is **not read
at all** until you press its **Show** button, so its values never reach your browser by default. This is
a convenience, **not a security control**: a name is only a hint (`notes` can hold a password;
`token_count` is harmless). If a user must not see something, give DataCanvas a database role that
cannot read it. **Hide** re-reads the page without the column, and the choice lasts only for the view you
have open. A sort or filter on a hidden column is refused until you reveal it, because it would reveal
the column one question at a time.

## Sorting

Click a column header: ascending, then descending, then back to key order. NULL sorts last ascending and
first descending (the database's own order). Rows that tie are ordered by the table's key, so every row
appears exactly once as you page. A column that cannot be sorted has no button and a tooltip that says
why: it is hidden, the table has no primary key or unique index to break ties, or its type has no useful
order (`json`, `jsonb`, arrays). Changing the sort starts again from the first page.

## Filtering

The **Filter** button opens a panel: choose a column, a condition and a value. Up to **ten conditions**
can be in force. Put them in groups when any one of several is enough ("A and (B or C)").

| Column kind                                                 | Conditions                                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Text                                                        | equals, does not equal, comparisons, is between, is one of a list, is none of a list, contains, does not contain, starts with, ends with, matches a pattern, is empty          |
| Ordered types (numbers, dates, booleans, enums and similar) | equals, does not equal, comparisons, is between, is one of a list, is none of a list; dates and timestamps also offer shortcuts (today, last 7 days, last 30 days, this month) |
| `json` / `jsonb`                                            | has the key, contains some JSON, the value at a path                                                                                                                           |
| Arrays                                                      | contains all of, contains any of, is empty                                                                                                                                     |
| Every column                                                | is NULL, is not NULL                                                                                                                                                           |

Other facts:

- **Filter by this value** (on a cell) builds a condition from the cell.
- **Saved filters** per table keep the _shape_ (columns and conditions), **never the values**, in your
  browser.
- "contains" and "starts with" ignore case and take what you type literally: no wildcards.
- "does not equal" also matches rows where the value is NULL.
- The value has to fit the column (a number for a number, a date such as `2026-01-31` for a date).
- While a filter is on, the page says "filtered" instead of the size estimate, because a count would scan
  the table.

## Time limit

A read with a sort or filter is stopped after **5 seconds** (a plain page keeps the usual 15-second
limit) and the page says so (`too_slow`). On a very large table, sort or filter by an indexed column;
"contains" on wide text is the slowest condition.

## Limits and rules

Only tables, partitioned tables, views and materialized views are read (a foreign table lives on another
server and is not). At most 2 MB per page (a shortened page says so). Rows are held in memory while the
Data section is open and are gone when you open another table, switch data viewing off, or disconnect.
They are never saved to a file, logged, or put in a snapshot or a workspace. Sorts, filter values and
typed values are held the same way.

---

**Sources:** [`docs/getting-started.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/getting-started.md),
[`README.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/README.md),
[`CHANGELOG.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/CHANGELOG.md) (1.8.0 filters),
[`packages/database-core/src/rows.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/database-core/src/rows.ts),
[`apps/web/features/data/`](https://github.com/ShubhamTiwari909/datacanvas/tree/main/apps/web/features/data).
`docs/getting-started.md` still describes "up to three conditions" and a shorter operator list; the ten-condition,
grouped model here follows the README and the 1.8.0 changelog entry. See
[Reading table data](/architecture/data-access/) for how this is built.
