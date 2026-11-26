/**
 * "Set a value on all matching rows" (`docs/write-side-v2-plan.md`, section 6): one column, one value, for every row
 * the filter on screen matches. Nothing is written here: "Preview" hands the change to the preview step, which finds
 * the matching rows, says how many there are, and asks for that count to be typed before Apply.
 */
"use client";

import { useState } from "react";
import type { RowColumn, RowFilter, TableEditInfo, TableRef } from "@datacanvas/database-core";
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
import type { ChangeRequest } from "./change-dialog";
import {
  MATCHING_DESCRIPTION,
  MATCHING_SET_LABEL,
  buildUpdateMatching,
  matchingSetChoices,
} from "./matching";
import { checkValue, typeHint } from "./row-edit";
import { ValueField, type ValueState } from "./value-field";

export function MatchingSetDialog({
  open,
  onClose,
  table,
  info,
  columns,
  filters,
  revealColumns,
  onPreview,
}: {
  open: boolean;
  onClose: () => void;
  table: TableRef;
  info: TableEditInfo;
  /** The page's columns: a column hidden there is not offered. */
  columns: readonly Pick<RowColumn, "name" | "masked">[];
  /** The filter exactly as the grid reads the page with it. */
  filters: readonly RowFilter[];
  revealColumns: readonly string[];
  onPreview: (request: ChangeRequest) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent size="form">
        {open ? (
          <Form
            table={table}
            info={info}
            columns={columns}
            filters={filters}
            revealColumns={revealColumns}
            onClose={onClose}
            onPreview={onPreview}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Form({
  table,
  info,
  columns,
  filters,
  revealColumns,
  onClose,
  onPreview,
}: {
  table: TableRef;
  info: TableEditInfo;
  columns: readonly Pick<RowColumn, "name" | "masked">[];
  filters: readonly RowFilter[];
  revealColumns: readonly string[];
  onClose: () => void;
  onPreview: (request: ChangeRequest) => void;
}) {
  const blurred = useBlurStore((s) => s.blurred);
  const choices = matchingSetChoices(info, columns);
  const [column, setColumn] = useState(choices[0]?.name ?? "");
  const [value, setValue] = useState<ValueState>({ mode: "value", text: "" });
  // Nothing is previewed until the person has given a value (an untouched form would write "" to every row).
  const [touched, setTouched] = useState(false);
  const chosen = choices.find((c) => c.name === column);
  const next = value.mode === "null" ? null : value.text;
  const problem =
    chosen && value.mode === "value" && value.text !== ""
      ? checkValue(chosen.dataType, value.text)
      : null;
  const ready = chosen !== undefined && problem === null && touched && filters.length > 0;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onPreview({
          change: buildUpdateMatching(table, filters, revealColumns, chosen.name, next),
          title: `Set ${chosen.name} on all matching rows of ${table.schema}.${table.name}`,
          description: MATCHING_DESCRIPTION,
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>{MATCHING_SET_LABEL}</DialogTitle>
        <DialogDescription>{MATCHING_DESCRIPTION}</DialogDescription>
      </DialogHeader>

      {choices.length === 0 ? (
        <p role="note" className="text-sm text-muted-foreground">
          No column of this table can be set in bulk (a key, a generated column, binary data and a
          hidden column cannot).
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

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready}>
          Preview
        </Button>
      </DialogFooter>
    </form>
  );
}
