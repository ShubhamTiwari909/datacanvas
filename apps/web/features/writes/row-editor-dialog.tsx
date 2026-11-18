/**
 * Editing one row. Each column the person may change gets a text area and, if
 * it can be empty, a NULL choice (NULL and the empty string are different
 * things). Columns that cannot be edited say why. Nothing is written here:
 * "Preview" hands the change to the preview step.
 */
"use client";

import { useState } from "react";
import { Undo2 } from "lucide-react";
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
import { FIELD_HINT, FormField, FormStack } from "@/components/ui/field";
import { useBlurStore } from "@/features/data/blur-store";
import type { ChangeRequest } from "./change-dialog";
import {
  buildUpdate,
  cellEditBlock,
  changedFields,
  checkValue,
  focusTarget,
  typeHint,
  updateBeforeAfter,
  type FieldEdit,
} from "./row-edit";
import { ValueField, type ValueState } from "./value-field";

/** A row as it was on screen when the editor opened. */
export interface RowSnapshot {
  columns: RowColumn[];
  cells: RowCell[];
  key: KeyValue[];
  /** The column to focus first (the cell the person started from), if any. */
  focus: string | null;
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
      <DialogContent size="form">
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
  // A column starts as it was read: its text, or NULL. (An edit offers "value" and "null" only.)
  const loaded = (value: string | null): ValueState =>
    value === null ? { mode: "null", text: "" } : { mode: "value", text: value };
  const [fields, setFields] = useState<Record<string, ValueState>>(() =>
    Object.fromEntries(
      row.columns.map((column, index) => [column.name, loaded(row.cells[index]?.value ?? null)]),
    ),
  );
  const stateOf = (name: string): ValueState => fields[name] ?? { mode: "null", text: "" };

  const editable = row.columns.flatMap((column, index) => {
    const cell = row.cells[index];
    if (!cell) return [];
    const columnInfo = info.columns.find((c) => c.name === column.name);
    return [{ column, cell, columnInfo, block: cellEditBlock(column, cell, columnInfo) }];
  });

  const edits: FieldEdit[] = editable
    .filter((e) => e.block === null)
    .map(({ column, cell }) => {
      const state = stateOf(column.name);
      return {
        column: column.name,
        original: cell.value,
        next: state.mode === "null" ? null : state.text,
      };
    });
  const change = buildUpdate(table, row.key, edits);
  const changedNames = new Set(changedFields(edits).map((f) => f.column));
  const focus = focusTarget(
    row.focus,
    editable.map((e) => ({
      name: e.column.name,
      editable: e.block === null,
      inKey: e.columnInfo?.inKey ?? false,
    })),
  );

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
      onKeyDown={(event) => {
        // Ctrl or Cmd plus Enter previews from anywhere in the form, including a text field.
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
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

      <FormStack className="gap-3">
        {editable.map(({ column, cell, columnInfo, block }) => {
          const state = stateOf(column.name);
          const problem =
            block === null && state.mode === "value"
              ? checkValue(column.dataType, state.text)
              : null;
          const changed = changedNames.has(column.name);
          return (
            <FormField
              key={column.name}
              label={<span className="font-mono">{column.name}</span>}
              meta={columnInfo?.inKey ? `${column.dataType} · key` : column.dataType}
              aside={
                changed ? (
                  <span className="flex items-center gap-1">
                    <span className="rounded-sm bg-muted px-1.5 text-xs leading-5 font-medium text-foreground">
                      Changed
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      aria-label={`Reset ${column.name}`}
                      title="Put it back as it was"
                      onClick={() =>
                        setFields((current) => ({ ...current, [column.name]: loaded(cell.value) }))
                      }
                    >
                      <Undo2 aria-hidden="true" />
                      Reset
                    </Button>
                  </span>
                ) : undefined
              }
              hint={block === null ? typeHint(column.dataType) : undefined}
              error={problem}
              reserveHint
            >
              {(field) =>
                block !== null ? (
                  <p id={field.id} className={FIELD_HINT}>
                    {block}
                  </p>
                ) : (
                  <ValueField
                    field={field}
                    dataType={column.dataType}
                    column={column.name}
                    state={state}
                    offers={{ null: columnInfo?.nullable ?? false, default: false }}
                    autoFocus={focus === column.name}
                    blurred={blurred}
                    onChange={(next) =>
                      setFields((current) => ({ ...current, [column.name]: next }))
                    }
                  />
                )
              }
            </FormField>
          );
        })}
      </FormStack>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={change === null}>
          Preview
        </Button>
        <p
          role="status"
          className="self-center text-xs text-muted-foreground sm:order-first sm:mr-auto"
        >
          {changedNames.size === 0
            ? "No changes yet. Change a value to preview it."
            : `${changedNames.size} ${changedNames.size === 1 ? "column" : "columns"} changed`}
        </p>
      </DialogFooter>
    </form>
  );
}
