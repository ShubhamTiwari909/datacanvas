---
title: Test releases 1.11.0 through 1.15.0
description: Manual smoke tests for Claude sharing, data editing, saved filters and SQL, and CLI schema drift.
---

These steps test the features introduced in 1.11.0 through 1.15.0 on a single **1.15.0 build**.
Use the fixture below throughout so you can compare your results with the expected values.

## Set up a test database

From the repository root, with Node 22.12 or later, pnpm 10, and Docker available,
build the app and start a PostgreSQL container:

```sh
pnpm install --frozen-lockfile
pnpm run package

docker run --rm -d --name datacanvas-release-qa \
  -e POSTGRES_PASSWORD=qa-local -e POSTGRES_DB=release_qa \
  -p 127.0.0.1:55433:5432 \
  --health-cmd 'pg_isready -h 127.0.0.1 -U postgres -d release_qa' \
  --health-interval 2s postgres:17
```

Wait for `docker ps --filter name=datacanvas-release-qa` to show **healthy**. Still at the repo root,
create the fixture and start DataCanvas with a separate data directory:

```sh
docker exec -i datacanvas-release-qa psql -U postgres -d release_qa -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public.qa_items (
  id integer PRIMARY KEY,
  region text NOT NULL,
  label text NOT NULL,
  amount integer NOT NULL CHECK (amount >= 0),
  notes text NOT NULL DEFAULT ''
);
INSERT INTO public.qa_items (id, region, label, amount, notes) VALUES
  (1, 'North', 'Alpha', 10, repeat('long text ', 600)),
  (2, 'North', 'Beta', 20, ''),
  (3, 'South', 'Gamma', 25, '');
CREATE ROLE qa_reader LOGIN PASSWORD 'qa-read';
GRANT USAGE ON SCHEMA public TO qa_reader;
GRANT SELECT ON public.qa_items TO qa_reader;
SQL

export DATACANVAS_HOME="$(mktemp -d)"
printf '%s\n' "$DATACANVAS_HOME"
node "$PWD/.package/bin/datacanvas.mjs" --enable-writes
```

Use **Connect PostgreSQL → Connection string** for these connections. Keep the app running between
sections unless a step specifically calls for a restart.

| Connection | Connection string                                                           |
| ---------- | --------------------------------------------------------------------------- |
| Owner      | `postgresql://postgres:qa-local@127.0.0.1:55433/release_qa?sslmode=disable` |
| Reader     | `postgresql://qa_reader:qa-read@127.0.0.1:55433/release_qa?sslmode=disable` |

## 1.11.0 — Share with Claude

1. Connect as **Reader**. Under the connection, choose **Share with Claude → Structure**. Set up
   an MCP client using the **Your app** picker and the [Claude setup guide](/guides/use-with-claude/).
   To use the repository build as a stdio server, set the client's command to `node` and its arguments
   to the absolute path to `.package/bin/datacanvas.mjs`, followed by `mcp`. Pass the same
   `DATACANVAS_HOME` to the client process.
2. Ask the client to describe `public.qa_items`. Expect columns and keys without any table rows.
   If your client exposes MCP resources and prompts, open its data dictionary and try a schema
   review prompt.
3. Turn on **Allow viewing table data** for Reader. Switch sharing to **Structure and data**,
   acknowledge the sharing notice, and keep **Ask me before** enabled. Request the first row of
   `qa_items`. Verify that DataCanvas prompts for consent. Choose **Deny**, then request it again
   and choose **Approve**. The client receives a row only after approval. Check the activity list
   for both outcomes.
4. Choose **Pause** and request the table structure again. Expect a refusal. Resume sharing and
   retry, then stop sharing before moving on.
5. Add `public.qa_items` to the canvas and click **Export**. In **Export diagram**, check that
   **Cancel**, **Documentation and diagram text…**, **Save as SVG**, and **Save as PNG** fit inside
   the dialog. Save a PNG and open it.

The [MCP guide](/guides/use-with-claude/) also covers the Claude Code plugin and Docker setup.
You can run the protocol and consent checks locally using the SDK test client in the automated
checks below.

## 1.12.0 — CSV import and bulk editing

Connect as **Owner**. Enable **Allow viewing table data**, save the connection as **QA owner**,
and use **Allow changes** to unlock it. Type `release_qa` when prompted. Open `public.qa_items`
and its Data section.

### Keyed CSV import

In a second terminal, create these CSVs:

```sh
qa_files="$(mktemp -d)"
printf 'id,region,label,amount\n6,South,Zeta,60\n' > "$qa_files/insert.csv"
printf 'id,region,label,amount\n1,North,Alpha CSV,12\n4,South,Delta,40\n' > "$qa_files/upsert.csv"
printf 'id,region,label,amount\n1,North,Keep Alpha,13\n5,West,Epsilon,50\n' > "$qa_files/keep.csv"
printf 'id,region,label,amount\n2,North,Beta CSV,22\n99,West,Missing,99\n' > "$qa_files/update.csv"
```

Choose **Import CSV** for each file in order. Map headers to the same-named columns, leave
`notes` unmapped, and choose `id` as the key for the update modes. For upserts that overwrite
existing rows, select `label` and `amount` as the fields to update. Validate, preview, and apply,
using the confirmation box when shown.

| File         | Mode                                                                       | Expected result                                                                                       |
| ------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `insert.csv` | **Add new rows only**                                                      | Row 6 appears.                                                                                        |
| `upsert.csv` | **Update existing rows, add the others**                                   | Row 1 becomes `Alpha CSV` with amount 12, and row 4 appears.                                          |
| `keep.csv`   | **Update existing rows, add the others → Leave existing rows as they are** | Row 5 appears and row 1 keeps `Alpha CSV` and amount 12.                                              |
| `update.csv` | **Update existing rows only**                                              | Row 2 becomes `Beta CSV` with amount 22. The preview counts one unmatched row and id 99 stays absent. |

As a negative check, repeat id 2 on two lines of an update CSV. The import should flag the
duplicate key before apply. Cancel it and verify row 2 still has amount 22.

### Rejects and encodings

1. Create a file with one valid row and one row that violates the amount check:

   ```sh
   printf 'id,region,label,amount\n7,West,Valid,70\n8,West,Invalid,-1\n' > "$qa_files/rejects.csv"
   ```

2. Import and validate it. Choose **Leave out the failing rows**, then **Download rejects file**.
   Verify that the download contains id 8 and the `datacanvas_reject_v1` diagnostic column.
   Apply the remaining rows. Expect id 7 to appear and id 8 to stay absent.
3. Change the rejected amount to a positive value and reopen the rejects file in **Import CSV**.
   Accept the offer to remove the diagnostic column, then validate and apply. Expect id 8 to appear.
4. Test the encoding picker with a Windows-1252 file. The octal escape below writes the byte for
   `é`. Choose **Windows-1252 / Latin-1**, import the file, and verify the label is **Café**.

   ```sh
   printf 'id,region,label,amount\n9,West,Caf\351,90\n' > "$qa_files/cafe.csv"
   ```

### Filter-wide changes, grid edits, and long text

1. Apply a filter for **region equals North**. Select a row to show the bulk toolbar, then choose
   **Set a value on all matching rows** and set `amount` to 30. Preview, type the displayed count
   **2**, check the confirmation, and apply. Both North rows should change, including the one you
   did not select. South and West rows keep their amounts.
2. Filter for **region equals West**, select a row, and choose **Delete all matching rows**.
   Preview should count four rows if you completed the import tests. Type the count, confirm, and
   apply. Clear the filter and verify that rows 5, 7, 8, and 9 are gone.
3. Double-click the `label` cell of row 1, enter `Inline Alpha`, and commit the cell edit. Choose
   **Review → Preview → Apply**. Reload the table data and verify the new label.
4. Open the truncated `notes` cell of row 1 and verify you can read and copy its full value.
   Choose **Edit this value**, change it to `Reviewed long note`, and preview and apply. Reopen
   the cell to verify the change.

## 1.13.0 — Spreadsheet paste and connection-scoped filters

1. Clear any filters and sort `qa_items` by `id` ascending. In a spreadsheet, copy a two-by-two
   block with the rows `Paste Alpha, 31` and `Paste Beta, 32`. Focus the first row's **label**
   cell with keyboard navigation and paste. Expect **4 cells in 2 rows changed** across
   `label` and `amount`. **Undo last** should clear the whole block. Paste again, choose
   **Review → Preview → Apply**, and reload to verify both rows.
2. On **QA owner**, apply **region equals North**, enter `By region` under **Save these filters as
   a shape**, and click **Save shape**. Load it again. The column and operator should return, and you
   should have to supply the value.
3. Open `qa_items` on the separate **Reader** connection with data viewing enabled. **By region**
   should be absent. Disconnect and reconnect **QA owner** in the same browser and at the same
   DataCanvas address. **By region** should still be there.
4. On an unsaved connection, save a different shape and disconnect. Reconnect and verify the shape
   is gone. If you have shared filters from 1.12.0 in this browser, open the table on **QA owner**
   and click **Move previous filters here**. Verify they appear on that profile.

For the CSV validation improvement, run the opt-in benchmark in [Automated checks](#automated-checks).
It asserts the rejected row numbers and prints round trips and elapsed time. Timing varies by machine.

## 1.14.0 — Saved SQL per connection

1. On **QA owner**, open **SQL** and type `SELECT id, label FROM public.qa_items ORDER BY id`.
   Choose **Saved queries**, name it `QA inventory`, and choose **Save current query**.
2. Search for `inventory` and choose **Open** on the matching entry. It opens in a new tab.
   Choose **Run** and verify the results. Rename the entry, then change the current editor SQL to
   `SELECT count(*) FROM public.qa_items` and use **Replace SQL for** that entry. Reopen it and
   verify that the new text was saved.
3. Open the **Saved queries** library on **Reader**. The owner's query should be absent. Restart
   DataCanvas with the same `DATACANVAS_HOME` and reconnect **QA owner**. The named query should
   still be available. Check that editor drafts, results, and execution history start fresh.
4. On a new temporary connection, save a query named `Temporary check`. Use **Save connection**
   to keep that profile, then disconnect and reconnect to verify the query was transferred. Delete
   the entry from the library and verify it disappears. A temporary connection you disconnect
   without saving loses its library.

## 1.15.0 — Schema drift CLI

1. In DataCanvas, open **Snapshots** on **QA owner**, name it `Baseline`, and choose
   **Take snapshot → Export**. Move the exported `Baseline.snapshot.json` to the CSV temp directory
   from the 1.12.0 steps, or set `baseline` below to wherever you saved it.
2. In a terminal at the repo root, run the packaged CLI. Expect **No differences** and exit code 0:

   ```sh
   export DATACANVAS_DATABASE_URL='postgresql://postgres:qa-local@127.0.0.1:55433/release_qa?sslmode=disable'
   cli="$PWD/.package/bin/datacanvas.mjs"
   baseline="$qa_files/Baseline.snapshot.json"
   node "$cli" schema check --baseline "$baseline"
   echo "$?"
   ```

3. Add a column and rerun in JSON mode. Expect status `drift`, the addition of `qa_flag`, and
   exit code 1:

   ```sh
   docker exec datacanvas-release-qa psql -U postgres -d release_qa -v ON_ERROR_STOP=1 \
     -c 'ALTER TABLE public.qa_items ADD COLUMN qa_flag boolean;'
   node "$cli" schema check --baseline "$baseline" --format json
   echo "$?"
   ```

4. Run the same check with the URL unset. Expect an error naming `DATACANVAS_DATABASE_URL` and
   exit code 2. A baseline from an older snapshot format without object metadata also exits 2
   when the comparisons it can perform show no drift.

   ```sh
   env -u DATACANVAS_DATABASE_URL node "$cli" schema check --baseline "$baseline"
   echo "$?"
   ```

5. Once 1.15.0 is available on npm, try the [GitHub Actions example](https://github.com/ShubhamTiwari909/datacanvas/blob/main/examples/github-actions/schema-drift.yml)
   in a test repository. Put the original DDL in `db/schema.sql`, commit the matching snapshot
   as `db/baseline.snapshot.json`, and run the workflow on a PR. The
   original DDL should pass. Add `qa_flag` in a new commit without updating the baseline and verify
   that the job fails and shows the drift report in the job summary.

## Automated checks

Run these from the repo root with the disposable test database still running. The specs create their
own databases on this PostgreSQL server. For the CSV benchmark, repeat on PostgreSQL 12 and 18 by
using the corresponding Docker images and adjusting the test URL as needed.

```sh
export DATACANVAS_TEST_PG_URL='postgresql://postgres:qa-local@127.0.0.1:55433/postgres?sslmode=disable'
pnpm exec playwright install chromium
pnpm run test:e2e e2e/mcp.spec.ts e2e/docs-export.spec.ts e2e/import-csv.spec.ts \
  e2e/bulk-edit.spec.ts e2e/edit-cells.spec.ts e2e/cut-text-edit.spec.ts e2e/sql-view.spec.ts
pnpm exec vitest run apps/web/features/data/filter-shapes.test.ts packages/cli/src/schema-check.test.ts
DC_SPIKE=1 pnpm exec vitest run packages/postgres-adapter/src/postgres.adapter.listall-spike.test.ts \
  -t 'release baseline'
```

When finished, stop DataCanvas with Ctrl+C and run `docker stop datacanvas-release-qa` to remove
the disposable database.

---

[Release changelog](https://github.com/ShubhamTiwari909/datacanvas/blob/main/CHANGELOG.md)
