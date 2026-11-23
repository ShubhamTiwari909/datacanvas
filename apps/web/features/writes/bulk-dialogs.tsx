/**
 * "Set a value" for the rows that were chosen in the grid (`docs/advanced-data-workspace-plan.md`, section 7;
 * decision 159): one column, one value, the same on every chosen row. Nothing is written here: "Preview" hands the
 * change to the preview step, which checks each row against the value it was seen holding and says which rows
 * changed since they were loaded.
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
import { SELECT_CLASS } from "@/components/ui/select";
import { useBlurStore } from "@/features/data/blur-store";
import { buildUpdateRows, bulkUpdateBeforeAfter, type SelectedRow } from "./bulk-select";
import type { ChangeRequest } from "./change-dialog";
import { checkValue, typeHint } from "./row-edit";
import { ValueField, type ValueState } from "./value-field";

export function BulkSetDialog({
  open,
  onClose,
  table,
  info,
  rows,
  onPreview,
}: {
  open: boolean;
  onClose: () => void;
  table: TableRef;
  info: TableEditInfo;
  rows: readonly SelectedRow[];
  onPreview: (request: ChangeRequest) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent size="form">
        {open ? (
          <Form table={table} info={info} rows={rows} onClose={onClose} onPreview={onPreview} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Form({
  table,
  info,
  rows,
  onClose,
  onPreview,
}: {
  table: TableRef;
  info: TableEditInfo;
  rows: readonly SelectedRow[];
  onClose: () => void;
  onPreview: (request: ChangeRequest) => void;
}) {
  const blurred = useBlurStore((s) => s.blurred);
  // A key column is left out: the same key on several rows would be refused, and a key is not what is set in bulk.
  const choices = info.columns.filter((c) => c.editable && !c.generated && !c.inKey);
  const [column, setColumn] = useState(choices[0]?.name ?? "");
  const [value, setValue] = useState<ValueState>({ mode: "value", text: "" });
  // Nothing is previewed until the person has given a value (an untouched form would write "" to every row, and
  // show "false" for a boolean it does not hold).
  const [touched, setTouched] = useState(false);
  const chosen = choices.find((c) => c.name === column);
  const next = value.mode === "null" ? null : value.text;
  const built = chosen ? buildUpdateRows(table, rows, chosen.name, next) : null;
  const problem =
    chosen && value.mode === "value" && value.text !== ""
      ? checkValue(chosen.dataType, value.text)
      : null;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!built || !chosen || problem || !touched) return;
        onPreview({
          change: built.change,
          title: `Set ${chosen.name} on ${built.change.rows.length} rows of ${table.schema}.${table.name}`,
          beforeAfter: bulkUpdateBeforeAfter(rows, chosen.name, next),
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>
          Set a value on {rows.length} {rows.length === 1 ? "row" : "rows"}
        </DialogTitle>
        <DialogDescription>
          The same value is written to the column you choose, on each chosen row, only if the row
          still holds what you saw. All of them are changed or none is.
        </DialogDescription>
      </DialogHeader>

      {choices.length === 0 ? (
        <p role="note" className="text-sm text-muted-foreground">
          No column of this table can be set in bulk (a key, a generated column and binary data
          cannot).
        </p>
      ) : (
        <FormStack className="gap-3">
          <FormField label="Column">
            {(field) => (
              <select
                {...field}
                className={SELECT_CLASS}
                value={column}
                onChange={(event) => {
                  setColumn(event.target.value);
                  setValue({ mode: "value", text: "" });
                  setTouched(false);
                }}
              >
                {choices.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.dataType})
                  </option>
                ))}
              </select>
            )}
          </FormField>
          {chosen ? (
            <FormField
              label="New value"
              meta={chosen.dataType}
              hint={typeHint(chosen.dataType)}
              error={problem}
              reserveHint
            >
              {(field) => (
                <ValueField
                  field={field}
                  dataType={chosen.dataType}
                  column={chosen.name}
                  state={value}
                  offers={{ null: chosen.nullable, default: false }}
                  blurred={blurred}
                  onChange={(next) => {
                    setValue(next);
                    setTouched(true);
                  }}
                />
              )}
            </FormField>
          ) : null}
        </FormStack>
      )}

      {built && built.leftOut > 0 ? (
        <p role="note" className="text-xs text-muted-foreground">
          {built.leftOut} of the chosen {built.leftOut === 1 ? "row holds" : "rows hold"} a value in
          this column that is too long to compare or was not shown when{" "}
          {built.leftOut === 1 ? "it was" : "they were"} chosen, so{" "}
          {built.leftOut === 1 ? "it is" : "they are"} left out.
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!built || problem !== null || !touched}>
          Preview
        </Button>
        <p
          role="status"
          className="self-center text-xs text-muted-foreground sm:order-first sm:mr-auto"
        >
          {built
            ? `${built.change.rows.length} ${built.change.rows.length === 1 ? "row" : "rows"} will be changed`
            : "No chosen row can be changed in this column."}
        </p>
      </DialogFooter>
    </form>
  );
}
