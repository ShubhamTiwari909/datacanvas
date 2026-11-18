/**
 * Row editing inside the Data section (1.4.0): the hint about how writing is
 * switched on, the "Add row" button, the editors, and the preview step.
 *
 * `useRowEditing` keeps everything in component state. The rows it works on
 * belong to the page on screen (the Data section's own state); nothing here is
 * stored, logged or sent anywhere except in the one preview request.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Plus } from "lucide-react";
import type { RowPage, TableEditInfo, TableRef } from "@datacanvas/database-core";
import { Button } from "@/components/ui/button";
import type { GridEditing } from "@/features/data/data-grid";
import { useAsyncData } from "@/lib/use-async-data";
import { useConnectionWrites, writesReady } from "@/stores/writes-store";
import { getEditInfo } from "./api";
import { ChangeDialog, type ChangeRequest } from "./change-dialog";
import { InsertRowDialog } from "./insert-row-dialog";
import { RowEditorDialog, type RowSnapshot } from "./row-editor-dialog";
import { buildDelete, deleteBeforeAfter, notEditableText, rowAddress } from "./row-edit";
import { NOT_LOCAL_TEXT } from "./writes-control";

export interface RowEditing {
  /** Row actions for the grid, or null when rows cannot be edited now. */
  grid: GridEditing | null;
  /** "Add row" for the toolbar, or nothing. */
  toolbar: React.ReactNode;
  /** One line on how editing is switched on, or why this table cannot be edited; null when nothing to say. */
  hint: React.ReactNode;
  /** The dialogs and the confirmation, rendered once below the grid. */
  dialogs: React.ReactNode;
}

export function useRowEditing({
  connectionId,
  table,
  page,
  reload,
}: {
  connectionId: string;
  table: TableRef;
  page: RowPage | null;
  /** Read the current page again (after a change, or when the row changed meanwhile). */
  reload: () => void;
}): RowEditing {
  const { status, structureVersion } = useConnectionWrites(connectionId);
  const ready = writesReady(status);
  const edit = useAsyncData<TableEditInfo | null>(
    () =>
      ready
        ? getEditInfo(connectionId, table.schema, table.name)
        : Promise.resolve({ ok: true, data: null }),
    JSON.stringify([connectionId, table.schema, table.name, ready, structureVersion]),
  );
  const info = edit.state.status === "success" ? edit.state.data : null;
  const [editRow, setEditRow] = useState<RowSnapshot | null>(null);
  const [inserting, setInserting] = useState(false);
  const [request, setRequest] = useState<ChangeRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // When writing stops being possible (locked, the connection gone, table data switched off) the
  // server drops its previews, so an open editor or preview would offer an Apply that cannot run.
  // Close them all as `ready` turns false (state adjusted while rendering, not in an effect).
  const [wasReady, setWasReady] = useState(ready);
  if (wasReady !== ready) {
    setWasReady(ready);
    if (!ready) {
      setEditRow(null);
      setInserting(false);
      setRequest(null);
    }
  }

  // The confirmation goes after a few seconds.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const grid = useMemo<GridEditing | null>(() => {
    if (!page || !info?.editable) return null;
    const address = (r: number) => rowAddress(page.columns, page.rows[r] ?? [], info);
    return {
      rowBlock: (r) => {
        const result = address(r);
        return result.ok ? null : result.reason;
      },
      onEdit: (r, col) => {
        const result = address(r);
        if (!result.ok) return;
        setEditRow({
          columns: page.columns,
          cells: [...(page.rows[r] ?? [])],
          key: result.key,
          focus: col === null ? null : (page.columns[col]?.name ?? null),
        });
      },
      onDelete: (r) => {
        const result = address(r);
        if (!result.ok) return;
        setRequest({
          change: buildDelete(table, result.key),
          title: `Delete a row of ${table.schema}.${table.name}`,
          beforeAfter: deleteBeforeAfter(page.columns, page.rows[r] ?? []),
        });
      },
    };
  }, [page, info, table]);

  let hint: string | null = null;
  if (!status.enabled) {
    hint =
      "DataCanvas was started read-only. To edit rows of a database on this machine, start it with --enable-writes.";
  } else if (!status.local) {
    hint = NOT_LOCAL_TEXT;
  } else if (!status.unlocked) {
    hint = "To edit rows, allow changes for this connection in the sidebar.";
  } else if (edit.state.status === "error") {
    hint = edit.state.error.message;
  } else if (info && !info.editable) {
    hint = notEditableText(info.reason);
  }

  const toolbar = info?.editable ? (
    <Button type="button" size="sm" variant="outline" onClick={() => setInserting(true)}>
      <Plus aria-hidden="true" />
      Add row
    </Button>
  ) : null;

  const dialogs = (
    <>
      {notice ? (
        <p role="status" className="flex items-center gap-1.5 text-sm">
          <CheckCircle2
            className="size-4 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
          {notice}
        </p>
      ) : null}
      {info ? (
        <>
          <RowEditorDialog
            table={table}
            info={info}
            row={editRow}
            onClose={() => setEditRow(null)}
            onPreview={(next) => {
              setEditRow(null);
              setRequest(next);
            }}
          />
          <InsertRowDialog
            table={table}
            info={info}
            open={inserting}
            onClose={() => setInserting(false)}
            onPreview={(next) => {
              setInserting(false);
              setRequest(next);
            }}
          />
        </>
      ) : null}
      <ChangeDialog
        connectionId={connectionId}
        request={request}
        onClose={() => setRequest(null)}
        onApplied={(_result, change) => {
          setRequest(null);
          setNotice(
            change.kind === "insert_row"
              ? "The row was added."
              : change.kind === "delete_row"
                ? "The row was deleted."
                : "The row was changed.",
          );
          reload();
        }}
        onRowChanged={() => {
          setRequest(null);
          reload();
        }}
      />
    </>
  );

  return {
    grid,
    toolbar,
    hint: hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null,
    dialogs,
  };
}
