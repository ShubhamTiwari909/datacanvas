/**
 * Editing one row. Each column the person may change gets a text area and, if
 * it can be empty, a NULL choice (NULL and the empty string are different
 * things). Columns that cannot be edited say why. Nothing is written here:
 * "Preview" hands the change to the preview step.
 */
"use client";

import { useState } from "react";
import type {
  KeyValue,
  RowCell,
  RowColumn,
  TableEditInfo,
  TableRef,
} from "@datacanvas/database-core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BLUR_CLASSES, useBlurStore } from "@/features/data/blur-store";
import { cn } from "@/lib/utils";
import type { ChangeRequest } from "./change-dialog";
import {
  buildUpdate,
  cellEditBlock,
  checkValue,
  typeHint,
  updateBeforeAfter,
  type FieldEdit,
} from "./row-edit";

/** A row as it was on screen when the editor opened. */
export interface RowSnapshot {
  columns: RowColumn[];
  cells: RowCell[];
  key: KeyValue[];
  /** The column to focus first (the cell the person started from), if any. */
  focus: string | null;
}

interface FieldState {
  text: string;
  isNull: boolean;
}

export function RowEditorDialog({
  table,
  info,
  row,
  onClose,
  onPreview,
}: {
  table: TableRef;
  info: TableEditInfo;
  row: RowSnapshot | null;
  onClose: () => void;
  onPreview: (request: ChangeRequest) => void;
}) {
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {row ? (
          // Keyed so a new row starts from its own values.
          <RowForm
            key={row.key.map((k) => k.value).join("\u0000")}
            table={table}
            info={info}
            row={row}
            onClose={onClose}
            onPreview={onPreview}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RowForm({
  table,
  info,
  row,
  onClose,
  onPreview,
}: {
  table: TableRef;
  info: TableEditInfo;
  row: RowSnapshot;
  onClose: () => void;
  onPreview: (request: ChangeRequest) => void;
}) {
  const blurred = useBlurStore((s) => s.blurred);
  const [fields, setFields] = useState<Record<string, FieldState>>(() =>
    Object.fromEntries(
      row.columns.map((column, index) => {
        const value = row.cells[index]?.value ?? null;
        return [column.name, { text: value ?? "", isNull: value === null }];
      }),
    ),
  );

  const editable = row.columns.flatMap((column, index) => {
    const cell = row.cells[index];
    if (!cell) return [];
    const columnInfo = info.columns.find((c) => c.name === column.name);
    return [{ column, cell, columnInfo, block: cellEditBlock(column, cell, columnInfo) }];
  });

  const edits: FieldEdit[] = editable
    .filter((e) => e.block === null)
    .map(({ column, cell }) => {
      const state = fields[column.name] ?? { text: "", isNull: true };
      return { column: column.name, original: cell.value, next: state.isNull ? null : state.text };
    });
  const change = buildUpdate(table, row.key, edits);

  const set = (name: string, next: Partial<FieldState>) =>
    setFields((current) => ({
      ...current,
      [name]: { ...(current[name] ?? { text: "", isNull: false }), ...next },
    }));

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!change) return;
        onPreview({
          change,
          title: `Edit a row of ${table.schema}.${table.name}`,
          beforeAfter: updateBeforeAfter(edits),
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>
          Edit a row of {table.schema}.{table.name}
        </DialogTitle>
        <DialogDescription>
          Row with {row.key.map((k) => k.column).join(", ")} as shown. Only the columns you change
          are written, and only if they still hold what you see here.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        {editable.map(({ column, columnInfo, block }) => {
          const id = `edit-${column.name}`;
          const state = fields[column.name] ?? { text: "", isNull: true };
          const hint = typeHint(column.dataType);
          const problem =
            block === null && !state.isNull ? checkValue(column.dataType, state.text) : null;
          const describedBy = [hint ? `${id}-hint` : null, problem ? `${id}-problem` : null]
            .filter(Boolean)
            .join(" ");
          return (
            <div key={column.name} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <label htmlFor={id} className="font-mono text-xs font-medium">
                  {column.name}
                </label>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {column.dataType}
                </span>
                {columnInfo?.inKey ? (
                  <span className="text-[10px] text-muted-foreground">key</span>
                ) : null}
              </div>
              {block !== null ? (
                <p id={id} className="text-xs text-muted-foreground">
                  {block}
                </p>
              ) : (
                <>
                  <textarea
                    id={id}
                    autoFocus={row.focus === column.name}
                    rows={Math.min(6, Math.max(1, state.text.split("\n").length))}
                    disabled={state.isNull}
                    value={state.isNull ? "" : state.text}
                    placeholder={state.isNull ? "NULL" : undefined}
                    onChange={(event) => set(column.name, { text: event.target.value })}
                    aria-describedby={describedBy || undefined}
                    aria-invalid={problem !== null}
                    className={cn(
                      "w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 dark:bg-input/30",
                      blurred && BLUR_CLASSES,
                    )}
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    {columnInfo?.nullable ? (
                      <label className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          className="size-3.5"
                          checked={state.isNull}
                          onChange={(event) => set(column.name, { isNull: event.target.checked })}
                        />
                        NULL
                        <span className="sr-only"> for {column.name}</span>
                      </label>
                    ) : null}
                    {hint ? (
                      <span id={`${id}-hint`} className="text-xs text-muted-foreground">
                        {hint}
                      </span>
                    ) : null}
                  </div>
                  {problem ? (
                    <p id={`${id}-problem`} className="text-xs text-destructive">
                      {problem}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          );
        })}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={change === null}>
          Preview
        </Button>
      </DialogFooter>
    </form>
  );
}
