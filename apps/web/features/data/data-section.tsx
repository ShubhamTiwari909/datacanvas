/**
 * The "Data" section of a table: its rows, read-only, one page at a time.
 *
 * Everything here is opt-in. While data access is off for the connection the
 * section only explains that and offers to switch it on; nothing is requested.
 * The rows are held by `useRows` for as long as this section is on screen.
 */
"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, Lock } from "lucide-react";
import type { TableInfo } from "@datacanvas/database-core";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { LoadingState } from "@/components/states/loading-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { describeRowEstimate } from "./cell-text";
import { DataGrid } from "./data-grid";
import { pageNotes } from "./page-notes";
import { PAGE_SIZES, canGoBack, pageNumber } from "./paging";
import { useRows } from "./use-rows";

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
        description="Off by default. When on, DataCanvas reads and shows the rows of the tables you open, read-only, one page at a time. Rows are never saved."
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

  if (view.status === "error") {
    return (
      <ErrorState
        title="Could not read the rows"
        message={view.error?.message ?? "Something went wrong."}
        onRetry={view.reload}
      />
    );
  }
  if (!page) return <LoadingState label="Reading rows…" />;

  const busy = view.status === "loading";
  const empty = page.columns.length === 0 || page.rows.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
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
            disabled={page.nextCursor === null || busy}
            onClick={() =>
              page.nextCursor !== null && dispatch({ type: "next", cursor: page.nextCursor })
            }
          >
            Next
            <ChevronRight aria-hidden="true" />
          </Button>
          <span role="status" className="text-sm text-muted-foreground">
            Page {pageNumber(paging)}
            {estimate ? ` · ${estimate}` : ""}
          </span>
        </div>
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

      {empty ? (
        <p role="status" className="text-sm text-muted-foreground">
          {page.columns.length === 0
            ? "This table has no columns."
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
          busy={busy}
        />
      )}

      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        {pageNotes(page).map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}
