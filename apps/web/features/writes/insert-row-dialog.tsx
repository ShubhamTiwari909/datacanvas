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
import { FIELD_ERROR, FIELD_HINT, FIELD_LABEL, FIELD_META, FormStack } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { BLUR_CLASSES, useBlurStore } from "@/features/data/blur-store";
import { cn } from "@/lib/utils";
import type { ChangeRequest } from "./change-dialog";
import {
  buildInsert,
  checkValue,
  initialInsertMode,
  insertBeforeAfter,
  insertModes,
  typeHint,
  type InsertField,
  type InsertMode,
} from "./row-edit";

const MODE_LABEL: Record<InsertMode, string> = {
  default: "Default",
  null: "NULL",
  value: "Value",
};

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

  const set = (name: string, next: Partial<InsertField>) =>
    setFields((current) => current.map((f) => (f.column === name ? { ...f, ...next } : f)));

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onPreview({
          change: buildInsert(table, fields),
          title: `Add a row to ${table.schema}.${table.name}`,
          beforeAfter: insertBeforeAfter(fields),
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>
          Add a row to {table.schema}.{table.name}
        </DialogTitle>
        <DialogDescription>
          Choose for each column: its default, NULL or a value. NULL and an empty value are
          different.
        </DialogDescription>
      </DialogHeader>

      <FormStack>
        {info.columns.map((column) => {
          const field = fields.find((f) => f.column === column.name);
          if (!field) return null;
          const modes = insertModes(column);
          const id = `insert-${column.name}`;
          const hint = typeHint(column.dataType);
          const problem = field.mode === "value" ? checkValue(column.dataType, field.value) : null;
          return (
            <fieldset key={column.name} className="flex flex-col gap-1.5">
              <legend className="flex flex-wrap items-baseline gap-2">
                <span className={cn("font-mono", FIELD_LABEL)}>{column.name}</span>
                <span className={FIELD_META}>{column.dataType}</span>
              </legend>
              <div
                className="flex flex-wrap items-center gap-3"
                role="radiogroup"
                aria-label={`What to put in ${column.name}`}
              >
                {modes.map((mode) => (
                  <label key={mode} className="flex items-center gap-1.5 text-xs">
                    <input
                      type="radio"
                      name={id}
                      value={mode}
                      checked={field.mode === mode}
                      onChange={() => set(column.name, { mode })}
                    />
                    {MODE_LABEL[mode]}
                    <span className="sr-only"> for {column.name}</span>
                  </label>
                ))}
                {field.mode === "default" ? (
                  <span className="text-xs text-muted-foreground">{defaultText(column)}</span>
                ) : null}
              </div>
              {field.mode === "value" ? (
                <>
                  <Textarea
                    id={id}
                    aria-label={`Value for ${column.name}`}
                    rows={1}
                    value={field.value}
                    onChange={(event) => set(column.name, { value: event.target.value })}
                    aria-invalid={problem !== null}
                    aria-describedby={
                      [hint ? `${id}-hint` : null, problem ? `${id}-problem` : null]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    className={cn("font-mono", blurred && BLUR_CLASSES)}
                  />
                  {hint ? (
                    <span id={`${id}-hint`} className={FIELD_HINT}>
                      {hint}
                    </span>
                  ) : null}
                  {problem ? (
                    <p id={`${id}-problem`} className={FIELD_ERROR}>
                      {problem}
                    </p>
                  ) : null}
                </>
              ) : null}
            </fieldset>
          );
        })}
      </FormStack>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Preview</Button>
      </DialogFooter>
    </form>
  );
}
