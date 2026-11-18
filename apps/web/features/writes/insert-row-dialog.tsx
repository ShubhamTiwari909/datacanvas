/**
 * Adding one row. For each column: leave it to the database (its default, or
 * NULL when it has none), NULL, or a typed value. Columns the database fills
 * (identity always, generated) can only be left to it.
 */
"use client";

import { useState } from "react";
import type { TableEditInfo, TableRef } from "@datacanvas/database-core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, FormStack } from "@/components/ui/field";
import { useBlurStore } from "@/features/data/blur-store";
import type { ChangeRequest } from "./change-dialog";
import {
  buildInsert,
  checkValue,
  controlKind,
  initialInsertMode,
  insertBeforeAfter,
  insertModes,
  typeHint,
  type InsertField,
  type InsertMode,
} from "./row-edit";
import { ValueField, type ValueState } from "./value-field";

export function InsertRowDialog({
  table,
  info,
  open,
  onClose,
  onPreview,
}: {
  table: TableRef;
  info: TableEditInfo;
  open: boolean;
  onClose: () => void;
  onPreview: (request: ChangeRequest) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent size="form">
        {open ? (
          <InsertForm table={table} info={info} onClose={onClose} onPreview={onPreview} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function defaultText(column: TableEditInfo["columns"][number]): string {
  if (column.generated) return "Filled by the database.";
  if (column.identity !== null) return "The next number from the identity.";
  if (column.hasDefault) return "The column's default.";
  return column.nullable ? "No default: NULL." : "No default.";
}

function InsertForm({
  table,
  info,
  onClose,
  onPreview,
}: {
  table: TableRef;
  info: TableEditInfo;
  onClose: () => void;
  onPreview: (request: ChangeRequest) => void;
}) {
  const blurred = useBlurStore((s) => s.blurred);
  const [fields, setFields] = useState<InsertField[]>(() =>
    info.columns.map((column) => ({
      column: column.name,
      mode: initialInsertMode(column),
      value: "",
    })),
  );

  const set = (name: string, next: ValueState) =>
    setFields((current) =>
      current.map((f) => (f.column === name ? { ...f, mode: next.mode, value: next.text } : f)),
    );

  const count = (mode: InsertMode) => fields.filter((f) => f.mode === mode).length;
  const filled = fields.filter((f) => f.mode === "value" && f.value !== "").length;
  const toFill = count("value") - filled;
  const summary = [
    filled > 0 ? `${filled} set` : null,
    toFill > 0 ? `${toFill} to fill in` : null,
    count("null") > 0 ? `${count("null")} NULL` : null,
    count("default") > 0 ? `${count("default")} left to the database` : null,
  ]
    .filter(Boolean)
    .join(", ");

  // A boolean with nothing chosen is not false: it cannot be previewed until true or false is picked.
  const unsetBoolean = fields.some(
    (f) =>
      f.mode === "value" &&
      f.value === "" &&
      controlKind(info.columns.find((c) => c.name === f.column)?.dataType ?? "") === "boolean",
  );

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (unsetBoolean) return;
        onPreview({
          change: buildInsert(table, fields),
          title: `Add a row to ${table.schema}.${table.name}`,
          beforeAfter: insertBeforeAfter(fields),
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
          Add a row to {table.schema}.{table.name}
        </DialogTitle>
        <DialogDescription>
          Fill in the columns you want. Default leaves a column to the database, and NULL gives it
          no value. NULL and an empty value are different.
        </DialogDescription>
      </DialogHeader>

      <FormStack className="gap-3">
        {info.columns.map((column) => {
          const field = fields.find((f) => f.column === column.name);
          if (!field) return null;
          const modes = insertModes(column);
          const locked = modes.length === 1 && modes[0] === "default";
          // An empty field is not an error yet: the person has not typed, and the database says so
          // when a required column is still empty.
          const problem =
            field.mode === "value" && field.value !== ""
              ? checkValue(column.dataType, field.value)
              : null;
          return (
            <FormField
              key={column.name}
              label={<span className="font-mono">{column.name}</span>}
              meta={column.dataType}
              hint={typeHint(column.dataType)}
              error={problem}
              reserveHint
            >
              {(control) => (
                <ValueField
                  field={control}
                  dataType={column.dataType}
                  column={column.name}
                  ariaLabel={`Value for ${column.name}`}
                  state={{ mode: field.mode, text: field.value }}
                  // A choice is offered only where there is one: a required column shows just its field.
                  offers={{
                    null: modes.includes("null"),
                    default: modes.includes("default") && modes.length > 1,
                  }}
                  defaultText={defaultText(column)}
                  locked={locked}
                  blurred={blurred}
                  onChange={(next) => set(column.name, next)}
                />
              )}
            </FormField>
          );
        })}
      </FormStack>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={unsetBoolean}>
          Preview
        </Button>
        <p
          role="status"
          className="self-center text-xs text-muted-foreground sm:order-first sm:mr-auto"
        >
          {summary}
        </p>
      </DialogFooter>
    </form>
  );
}
