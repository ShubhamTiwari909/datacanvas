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
import {
  CheckCircle2,
  Download,
  FileUp,
  ListChecks,
  PencilLine,
  Plus,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  isSensitiveColumnName,
  type KeyValue,
  type RowFilter,
  type RowPage,
  type TableEditInfo,
  type TableRef,
} from "@datacanvas/database-core";
import { IMPORT_MAX_BODY_BYTES } from "@datacanvas/shared-types";
import { Button } from "@/components/ui/button";
import { FIELD_ERROR } from "@/components/ui/field";
import type { GridCellEditing, GridEditing, GridSelection } from "@/features/data/data-grid";
import { ImportDialog } from "@/features/import/import-dialog";
import { appliedText, isKeyedImport } from "@/features/import/keyed-text";
import { useAsyncData } from "@/lib/use-async-data";
import { useConnectionWrites, writesReady } from "@/stores/writes-store";
import { getEditInfo } from "./api";
import { BulkSetDialog } from "./bulk-dialogs";
import {
  BULK_PREVIEW_ROWS,
  EMPTY_SELECTION,
  buildDeleteRows,
  bulkDeleteBeforeAfter,
  rowSignature,
  pageSelectable,
  pageState,
  toggleRow,
  togglePage,
  type Selection,
} from "./bulk-select";
import { ChangeDialog, type ChangeRequest } from "./change-dialog";
import { CUT_TEXT_OPEN_TEXT, canEditCutText } from "./cut-text";
import { EditCellsDialog } from "./edit-cells-dialog";
import { InsertRowDialog } from "./insert-row-dialog";
import { MatchingSetDialog } from "./matching-dialog";
import {
  MATCHING_DELETE_LABEL,
  MATCHING_DESCRIPTION,
  MATCHING_SET_LABEL,
  buildDeleteMatching,
  isMatchingKind,
  offersMatching,
} from "./matching";
import {
  BODY_LIMIT_TEXT,
  EMPTY_PENDING,
  appliedCellsText,
  buildEditCells,
  cellsWritten,
  countPending,
  gridCellBlock,
  keyLabel,
  pendingBySignature,
  pendingReducer,
  pendingText,
  type PendingAction,
  type PendingState,
} from "./pending-cells";
import { planCellPaste } from "./paste-cells";
import { RowEditorDialog, type RowSnapshot } from "./row-editor-dialog";
import {
  buildDelete,
  deleteBeforeAfter,
  notEditableText,
  rowAddress,
  type ShownValue,
} from "./row-edit";
import { NOT_LOCAL_TEXT } from "./writes-control";

export interface RowEditing {
  /** Row actions for the grid, or null when rows cannot be edited now. */
  grid: GridEditing | null;
  /** Choosing rows for a bulk change, or null when rows cannot be changed now. */
  selection: GridSelection | null;
  /** "Add row" for the toolbar, or nothing. */
  toolbar: React.ReactNode;
  /** One line on how editing is switched on, or why this table cannot be edited; null when nothing to say. */
  hint: React.ReactNode;
  /** The bar of the cells edited in the grid and not sent yet, or nothing. */
  pending: React.ReactNode;
  /** The dialogs and the confirmation, rendered once below the grid. */
  dialogs: React.ReactNode;
}

export function useRowEditing({
  connectionId,
  table,
  page,
  filters = [],
  revealColumns = [],
  reload,
  onExportChosen,
}: {
  connectionId: string;
  table: TableRef;
  page: RowPage | null;
  /** The filter on screen, exactly as the page was read with it: the rows "all matching rows" are. */
  filters?: readonly RowFilter[];
  /** The hidden columns the person revealed, as the page was read with them. */
  revealColumns?: readonly string[];
  /** Read the current page again (after a change, or when the row changed meanwhile). */
  reload: () => void;
  /** Export the chosen rows (by their keys): a button beside the bulk changes. */
  onExportChosen?: (keys: KeyValue[][]) => void;
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
  // The rows chosen for a bulk change: by key, in memory, kept across pages and filters, and let go of when the
  // table changes (the choice belongs to the table it was made in).
  const tableKey = JSON.stringify([connectionId, table.schema, table.name]);
  const [chosen, setChosen] = useState<{
    table: string;
    rows: Selection;
    anchor: number | null;
    /** The page the anchor is an index of: after a new page, sort or filter it points at another row, so it is let go of. */
    anchorPage: unknown;
    limited: boolean;
  }>({ table: tableKey, rows: EMPTY_SELECTION, anchor: null, anchorPage: null, limited: false });
  // Another table or connection: the old choice is dropped (state adjusted while rendering), not just hidden, so
  // coming back to a table never restores rows and snapshots chosen earlier.
  if (chosen.table !== tableKey) {
    setChosen({
      table: tableKey,
      rows: EMPTY_SELECTION,
      anchor: null,
      anchorPage: null,
      limited: false,
    });
  }
  const selected = chosen.table === tableKey ? chosen.rows : EMPTY_SELECTION;
  const [setting, setSetting] = useState(false);
  const [settingMatching, setSettingMatching] = useState(false);
  const [importing, setImporting] = useState(false);
  // The cells edited in the grid and not sent yet: in memory only, for this table and this filter. Another table,
  // another connection or another filter drops them (state adjusted while rendering), and so does locking.
  const pendingScope = JSON.stringify([connectionId, table.schema, table.name, filters]);
  const [pendingOf, setPendingOf] = useState<{ scope: string; state: PendingState }>({
    scope: pendingScope,
    state: EMPTY_PENDING,
  });
  if (pendingOf.scope !== pendingScope) setPendingOf({ scope: pendingScope, state: EMPTY_PENDING });
  const pending = pendingOf.scope === pendingScope ? pendingOf.state : EMPTY_PENDING;
  const dispatchPending = (action: PendingAction) =>
    setPendingOf((current) => ({
      scope: current.scope,
      state: pendingReducer(current.state, action),
    }));
  // A column hidden again cannot be edited: its pending cells go (the others stay).
  const revealKey = JSON.stringify(revealColumns);
  const [prunedFor, setPrunedFor] = useState(revealKey);
  if (prunedFor !== revealKey) {
    setPrunedFor(revealKey);
    setPendingOf((current) => ({
      scope: current.scope,
      state: pendingReducer(current.state, {
        type: "prune",
        keep: (column) => !isSensitiveColumnName(column) || revealColumns.includes(column),
      }),
    }));
  }
  const [reviewing, setReviewing] = useState(false);
  const clearSelection = () =>
    setChosen({
      table: tableKey,
      rows: EMPTY_SELECTION,
      anchor: null,
      anchorPage: null,
      limited: false,
    });

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
      setSetting(false);
      setSettingMatching(false);
      setImporting(false);
      setReviewing(false);
      clearSelection();
      setPendingOf({ scope: pendingScope, state: EMPTY_PENDING });
    }
  }

  // The confirmation goes after a few seconds.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const rowsGrid = useMemo<GridEditing | null>(() => {
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

  const selectable = useMemo(
    () => (page && info?.editable ? pageSelectable(page, info) : []),
    [page, info],
  );
  const selection = useMemo<GridSelection | null>(() => {
    if (!page || !info?.editable) return null;
    const apply = (next: { rows: Selection; anchor: number | null; limited: boolean }) =>
      setChosen({ table: tableKey, ...next, anchorPage: page });
    return {
      isSelected: (r) => {
        const row = selectable[r];
        return row !== null && row !== undefined && selected.has(rowSignature(row.key));
      },
      onToggle: (r, extend) => {
        const anchor = chosen.anchorPage === page ? chosen.anchor : null;
        const next = toggleRow(selected, selectable, r, extend, anchor);
        apply({ rows: next.selection, anchor: next.anchor, limited: next.limited });
      },
      pageState: pageState(selected, selectable),
      onTogglePage: () => {
        const next = togglePage(selected, selectable);
        apply({ rows: next.selection, anchor: next.anchor, limited: next.limited });
      },
    };
  }, [page, info, selectable, selected, chosen.anchor, chosen.anchorPage, tableKey]);
  const chosenRows = [...selected.values()];

  // Editing cells in place (1.12.0): each row is found by the key `selectable` read from the page.
  const pendingRows = useMemo(() => pendingBySignature(pending), [pending]);
  const cells = useMemo<GridCellEditing | null>(() => {
    if (!page || !info?.editable) return null;
    const rowKey = (r: number) => selectable[r]?.key ?? null;
    const cellBlock = (r: number, c: number) => {
      const column = page.columns[c];
      const cell = page.rows[r]?.[c];
      if (!column || !cell) return "This cell cannot be edited here.";
      const address = rowAddress(page.columns, page.rows[r] ?? [], info);
      const rowBlock = address.ok ? null : address.reason;
      const columnInfo = info.columns.find((col) => col.name === column.name);
      const block = gridCellBlock(rowBlock, column, cell, columnInfo);
      // A cut text cell is not edited in place, but its dialog can read and edit the whole value.
      return block !== null && canEditCutText(rowBlock, column, cell, columnInfo)
        ? CUT_TEXT_OPEN_TEXT
        : block;
    };
    return {
      cellBlock,
      cutText: (r, c) => {
        const column = page.columns[c];
        const cell = page.rows[r]?.[c];
        const key = rowKey(r);
        if (!key || !column || !cell) return null;
        const address = rowAddress(page.columns, page.rows[r] ?? [], info);
        if (
          !canEditCutText(
            address.ok ? null : address.reason,
            column,
            cell,
            info.columns.find((col) => col.name === column.name),
          )
        )
          return null;
        const change =
          pendingRows.get(rowSignature(key))?.cells.find((p) => p.column === column.name) ?? null;
        return { pending: change ? { before: change.before, after: change.after } : null };
      },
      pendingRow: (r) => {
        const key = rowKey(r);
        return key ? (pendingRows.get(rowSignature(key)) ?? null) : null;
      },
      nullable: (name) => info.columns.find((col) => col.name === name)?.nullable ?? false,
      onSet: (r, c, value, before) => {
        const key = rowKey(r);
        const column = page.columns[c];
        const cell = page.rows[r]?.[c];
        if (!key || !column || !cell) return;
        setPendingOf((current) => ({
          scope: current.scope,
          state: pendingReducer(current.state, {
            type: "set",
            key,
            column: column.name,
            // A cut cell holds only the start of its value: the dialog passes the whole value it read.
            before: before !== undefined ? before : cell.value,
            after: value,
          }),
        }));
      },
      onPaste: (row, column, text) => {
        const paste = planCellPaste(
          text,
          row,
          column,
          {
            rows: page.rows.length,
            columns: page.columns.length,
          },
          (r, c) => {
            const block = cellBlock(r, c);
            if (block !== null) return block;
            const key = rowKey(r);
            return key
              ? { key, column: page.columns[c]!.name, before: page.rows[r]![c]!.value }
              : "This row has no usable key.";
          },
        );
        setPendingOf((current) => {
          const state = pendingReducer(
            current.state,
            "reason" in paste
              ? { type: "refuse", reason: paste.reason }
              : { type: "paste", cells: paste.cells },
          );
          const change =
            state.rows === current.state.rows ? null : buildEditCells(table, state, revealColumns);
          return {
            scope: current.scope,
            state:
              change &&
              new TextEncoder().encode(JSON.stringify({ change })).length > IMPORT_MAX_BODY_BYTES
                ? { ...current.state, refusal: BODY_LIMIT_TEXT }
                : state,
          };
        });
      },
      onUndo: () =>
        setPendingOf((current) => ({
          scope: current.scope,
          state: pendingReducer(current.state, { type: "undo" }),
        })),
    };
  }, [page, info, selectable, pendingRows, table, revealColumns]);
  const grid = useMemo<GridEditing | null>(
    () => (rowsGrid ? { ...rowsGrid, cells } : null),
    [rowsGrid, cells],
  );
  const pendingCounts = countPending(pending);

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
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setInserting(true)}>
        <Plus aria-hidden="true" />
        Add row
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={() => setImporting(true)}>
        <FileUp aria-hidden="true" />
        Import CSV
      </Button>
      {offersMatching(filters, info) ? (
        <span
          role="group"
          aria-label="Rows that match the filter"
          className="flex items-center gap-2"
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setSettingMatching(true)}
          >
            <ListChecks aria-hidden="true" />
            {MATCHING_SET_LABEL}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              setRequest({
                change: buildDeleteMatching(table, filters, revealColumns),
                title: `Delete all matching rows of ${table.schema}.${table.name}`,
                description: MATCHING_DESCRIPTION,
              })
            }
          >
            <Trash2 aria-hidden="true" />
            {MATCHING_DELETE_LABEL}
          </Button>
        </span>
      ) : null}
      {chosenRows.length > 0 ? (
        <span role="group" aria-label="Chosen rows" className="flex items-center gap-2">
          <span role="status" className="text-sm">
            {chosenRows.length} {chosenRows.length === 1 ? "row" : "rows"} chosen
            {chosen.limited ? " (the most for one change)" : ""}
          </span>
          <Button type="button" size="sm" variant="outline" onClick={() => setSetting(true)}>
            <ListChecks aria-hidden="true" />
            Set a value
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              setRequest({
                change: buildDeleteRows(table, chosenRows),
                title: `Delete ${chosenRows.length} ${chosenRows.length === 1 ? "row" : "rows"} of ${table.schema}.${table.name}`,
                beforeAfter: bulkDeleteBeforeAfter(chosenRows),
              })
            }
          >
            <Trash2 aria-hidden="true" />
            Delete {chosenRows.length} {chosenRows.length === 1 ? "row" : "rows"}
          </Button>
          {onExportChosen ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onExportChosen(chosenRows.map((r) => r.key))}
            >
              <Download aria-hidden="true" />
              Export chosen
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={clearSelection}>
            <X aria-hidden="true" />
            Clear
          </Button>
        </span>
      ) : null}
    </>
  ) : null;

  const pendingBar =
    info?.editable && (pendingCounts.cells > 0 || pending.refusal !== null) ? (
      <div
        role="group"
        aria-label="Pending changes"
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-muted/30 px-2 py-1.5"
      >
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <PencilLine className="size-4 text-amber-700 dark:text-amber-400" aria-hidden="true" />
          <span role="status">{pendingText(pendingCounts)}</span>
        </span>
        <span className="text-xs text-muted-foreground">
          Not saved yet. Another table or filter, or locking changes, drops them.
        </span>
        <span className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={pendingCounts.cells === 0}
            onClick={() => setReviewing(true)}
          >
            Review
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending.undo.length === 0}
            onClick={() => dispatchPending({ type: "undo" })}
          >
            <Undo2 aria-hidden="true" />
            Undo last
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => dispatchPending({ type: "discard" })}
          >
            <X aria-hidden="true" />
            Discard all
          </Button>
        </span>
        {pending.refusal ? (
          <p role="alert" className={`${FIELD_ERROR} basis-full`}>
            {pending.refusal}
          </p>
        ) : null}
      </div>
    ) : null;

  const shownValue = (value: string | null): ShownValue =>
    value === null ? { kind: "null" } : { kind: "value", text: value, cut: false };

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
            connectionId={connectionId}
            table={table}
            info={info}
            row={editRow}
            onClose={() => setEditRow(null)}
            onPreview={(next) => {
              setEditRow(null);
              setRequest(next);
            }}
          />
          <ImportDialog
            open={importing}
            onClose={() => setImporting(false)}
            connectionId={connectionId}
            table={table}
            info={info}
            onPreview={(next) => {
              setImporting(false);
              setRequest(next);
            }}
          />
          <BulkSetDialog
            open={setting}
            onClose={() => setSetting(false)}
            table={table}
            info={info}
            rows={chosenRows}
            onPreview={(next) => {
              setSetting(false);
              setRequest(next);
            }}
          />
          {page ? (
            <MatchingSetDialog
              open={settingMatching && offersMatching(filters, info)}
              onClose={() => setSettingMatching(false)}
              table={table}
              info={info}
              columns={page.columns}
              filters={filters}
              revealColumns={revealColumns}
              onPreview={(next) => {
                setSettingMatching(false);
                setRequest(next);
              }}
            />
          ) : null}
          <EditCellsDialog
            open={reviewing}
            table={table}
            pending={pending}
            onClose={() => setReviewing(false)}
            onRevert={(signature, column) => dispatchPending({ type: "revert", signature, column })}
            onPreview={() => {
              const change = buildEditCells(table, pending, revealColumns);
              if (!change) return;
              setReviewing(false);
              setRequest({
                change,
                title: `Edit ${pendingText(pendingCounts).replace(/ changed$/, "")} of ${table.schema}.${table.name}`,
                // The first cells, labelled by their row and column; the review listed them all.
                beforeAfter: pending.rows
                  .flatMap((row) =>
                    row.cells.map((cell) => ({
                      column: `${keyLabel(row.key)} · ${cell.column}`,
                      before: shownValue(cell.before),
                      after: shownValue(cell.after),
                    })),
                  )
                  .slice(0, BULK_PREVIEW_ROWS),
              });
            }}
          />
          <InsertRowDialog
            connectionId={connectionId}
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
        onApplied={(result, change, preview) => {
          setRequest(null);
          const many = (n: number) =>
            `${n.toLocaleString("en-US")} ${n === 1 ? "row was" : "rows were"}`;
          setNotice(
            change.kind === "edit_cells"
              ? appliedCellsText(cellsWritten(change, preview.skipped))
              : change.kind === "insert_row"
                ? "The row was added."
                : change.kind === "delete_row"
                  ? "The row was deleted."
                  : change.kind === "update_rows" || change.kind === "update_matching"
                    ? `${many(result.rowCount)} changed.`
                    : change.kind === "delete_rows" || change.kind === "delete_matching"
                      ? `${many(result.rowCount)} deleted.`
                      : change.kind === "insert_rows"
                        ? `${many(result.rowCount)} added.`
                        : isKeyedImport(change)
                          ? appliedText(change, result)
                          : "The row was changed.",
          );
          // The rows that were changed or removed are not the rows that were chosen any more.
          if (
            change.kind === "update_rows" ||
            change.kind === "delete_rows" ||
            isMatchingKind(change.kind)
          )
            clearSelection();
          // The cells were written (or their rows were left out, to be looked at again): none is pending now.
          if (change.kind === "edit_cells") dispatchPending({ type: "discard" });
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
    selection,
    toolbar,
    hint: hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null,
    pending: pendingBar,
    dialogs,
  };
}
