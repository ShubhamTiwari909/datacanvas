/**
 * The "Data" section of a table: its rows, read-only, one page at a time.
 *
 * Everything here is opt-in. While data access is off for the connection the
 * section only explains that and offers to switch it on; nothing is requested.
 * The rows are held by `useRows` for as long as this section is on screen.
 */
"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { ROWS_MAX_FILTERS, type TableInfo } from "@datacanvas/database-core";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { LoadingState } from "@/components/states/loading-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useBlurStore } from "./blur-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { describeRowEstimate } from "./cell-text";
import { DataGrid } from "./data-grid";
import { FilterBar } from "./filter-bar";
import { pageNotes } from "./page-notes";
import { PAGE_SIZES, canGoBack, pageNumber } from "./paging";
import { nextSort } from "./sorting";
import { useRows } from "./use-rows";
import { useRowEditing } from "@/features/writes/row-editing";
import type { ApiFailure } from "@/lib/api-client";
import type { PagingAction } from "./paging";

export function DataSection({
  connectionId,
  schema,
  table,
  info,
}: {
  connectionId: string;
  schema: string;
  table: string;
  info: TableInfo | undefined;
}) {
  const connection = useWorkspaceStore((s) => s.connections.find((c) => c.id === connectionId));
  const setDataAccess = useWorkspaceStore((s) => s.setDataAccess);
  const [switching, setSwitching] = useState(false);

  const heading = (
    <div className="flex flex-wrap items-center gap-3">
      <h3
        id="data-heading"
        className="text-sm font-semibold tracking-wide text-muted-foreground uppercase"
      >
        Data
      </h3>
      {connection?.dataAccess ? <Badge variant="outline">Data access: on</Badge> : null}
      {connection?.dataAccess ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={switching}
          onClick={() => {
            setSwitching(true);
            void setDataAccess(connectionId, false).finally(() => setSwitching(false));
          }}
        >
          Turn off
        </Button>
      ) : null}
    </div>
  );

  let body: React.ReactNode;
  if (!connection?.dataAccess) {
    body = (
      <EmptyState
        icon={Lock}
        title="Table data is switched off"
        description="Off by default. When on, DataCanvas reads and shows the rows of the tables you open, one page at a time. Rows are never saved."
      >
        <Button
          type="button"
          disabled={switching}
          onClick={() => {
            setSwitching(true);
            void setDataAccess(connectionId, true).finally(() => setSwitching(false));
          }}
        >
          Allow viewing table data
        </Button>
      </EmptyState>
    );
  } else if (info?.kind === "foreign_table") {
    body = (
      <p className="text-sm text-muted-foreground">
        The rows of a foreign table are not shown: they live on another server, which DataCanvas
        does not read from.
      </p>
    );
  } else {
    body = <Rows connectionId={connectionId} schema={schema} table={table} info={info} />;
  }

  return (
    <section aria-labelledby="data-heading" className="flex flex-col gap-3">
      {heading}
      {body}
    </section>
  );
}

function Rows({
  connectionId,
  schema,
  table,
  info,
}: {
  connectionId: string;
  schema: string;
  table: string;
  info: TableInfo | undefined;
}) {
  const view = useRows(connectionId, schema, table);
  const { page, paging, dispatch } = view;
  const estimate = describeRowEstimate(info?.estimatedRowCount ?? null);
  const blurred = useBlurStore((s) => s.blurred);
  const setBlurred = useBlurStore((s) => s.setBlurred);
  const ref = useMemo(() => ({ schema, name: table }), [schema, table]);
  // With writes unlocked (1.4.0): row actions, "Add row" and the preview step. Inert otherwise.
  const editing = useRowEditing({ connectionId, table: ref, page, reload: view.reload });

  if (!page) {
    // The first read failed (or is still running): there is no page yet to build a filter panel from.
    if (view.status === "error") {
      return (
        <ErrorState
          title="Could not read the rows"
          message={view.error?.message ?? "Something went wrong."}
          onRetry={view.reload}
        />
      );
    }
    return <LoadingState label="Reading rows…" />;
  }

  const failed = view.status === "error";
  const busy = view.status === "loading";
  const filtered = paging.filters.length > 0;
  const empty = page.columns.length === 0 || page.rows.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <div
        data-slot="data-toolbar"
        className="flex items-center gap-x-4 gap-y-2 overflow-x-auto rounded-lg border bg-muted/30 px-2 py-1.5 whitespace-nowrap sm:flex-wrap sm:overflow-visible [&>*]:shrink-0"
      >
        <div role="group" aria-label="Paging" className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canGoBack(paging) || busy}
            onClick={() => dispatch({ type: "previous" })}
          >
            <ChevronLeft aria-hidden="true" />
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page.nextCursor === null || busy || failed}
            onClick={() =>
              page.nextCursor !== null && dispatch({ type: "next", cursor: page.nextCursor })
            }
          >
            Next
            <ChevronRight aria-hidden="true" />
          </Button>
          <span role="status" className="text-sm text-muted-foreground">
            Page {pageNumber(paging)}
            {/* The estimate describes the whole table; with a filter on it would describe the wrong thing. */}
            {filtered ? " · filtered" : estimate ? ` · ${estimate}` : ""}
          </span>
        </div>
        {editing.toolbar ? (
          <div role="group" aria-label="Actions" className="flex items-center gap-2">
            {editing.toolbar}
          </div>
        ) : null}
        <div role="group" aria-label="View" className="ml-auto flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={blurred} onCheckedChange={setBlurred} />
            Blur values
          </label>
          <label className="flex items-center gap-2 text-sm">
            Rows per page
            <select
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              value={paging.pageSize}
              onChange={(event) =>
                dispatch({ type: "pageSize", pageSize: Number(event.target.value) })
              }
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {editing.hint}

      {/* Always shown once there is a page, even after a failed read: a condition that was refused has to be removable. */}
      <FilterBar
        schema={schema}
        table={table}
        columns={page.columns}
        filters={paging.filters}
        onAdd={(filter) => dispatch({ type: "addFilter", filter })}
        onRemove={(index) => dispatch({ type: "removeFilter", index })}
        onClear={() => dispatch({ type: "clearFilters" })}
      />

      {failed ? (
        <RowsError
          error={view.error}
          filters={filtered}
          sorted={paging.sort !== null}
          dispatch={dispatch}
          onRetry={view.reload}
        />
      ) : empty ? (
        <p role="status" className="text-sm text-muted-foreground">
          {page.columns.length === 0
            ? "This table has no columns."
            : filtered
              ? pageNumber(paging) > 1
                ? "There are no more rows that match."
                : "No rows match these filters."
              : pageNumber(paging) > 1
                ? "There are no more rows."
                : "This table has no rows."}
        </p>
      ) : (
        <DataGrid
          page={page}
          caption={`Rows of ${schema}.${table}, page ${pageNumber(paging)}`}
          revealed={paging.reveal}
          onReveal={(column) => dispatch({ type: "reveal", column })}
          onHide={(column) => dispatch({ type: "hide", column })}
          sort={paging.sort}
          onSort={(column) => dispatch({ type: "sort", sort: nextSort(paging.sort, column) })}
          busy={busy}
          source={{ connectionId, table: { schema, name: table } }}
          editing={editing.grid}
          onFilterCell={
            paging.filters.length < ROWS_MAX_FILTERS
              ? (filter) => dispatch({ type: "addFilter", filter })
              : undefined
          }
        />
      )}

      {editing.dialogs}

      {failed ? null : (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {pageNotes(page).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A read that failed, with the page's own controls still around it. The sentences are the server's fixed ones
 * or these: the database's message (which contains the value) never reaches the screen. A condition that was
 * refused (a value that does not fit the column, or a condition the column does not allow) can be removed here.
 */
function RowsError({
  error,
  filters,
  sorted,
  dispatch,
  onRetry,
}: {
  error: ApiFailure | null;
  /** Filters are on, so they may be the cause. */
  filters: boolean;
  sorted: boolean;
  dispatch: (action: PagingAction) => void;
  onRetry: () => void;
}) {
  const code = error?.code ?? "";
  const refusedFilter = code === "invalid_request" && filters;
  const message = refusedFilter
    ? "That value is not valid for this column's type, or the condition is not allowed for it. Change the value or remove the filter."
    : (error?.message ?? "Something went wrong.");
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 text-destructive" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Could not read the rows</p>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {filters ? (
          <Button type="button" size="sm" onClick={() => dispatch({ type: "clearFilters" })}>
            Remove the filters
          </Button>
        ) : null}
        {sorted && code === "too_slow" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => dispatch({ type: "sort", sort: null })}
          >
            Remove the sort
          </Button>
        ) : null}
        {refusedFilter ? null : (
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
