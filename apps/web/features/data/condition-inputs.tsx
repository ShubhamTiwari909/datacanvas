/**
 * The boxes a condition asks for, by what its operator takes: one value, a path and a value, a
 * list (one per line) or the two ends of a range. Shared by the filter panel and the form that
 * fills in a saved shape. What is typed here stays in the component that owns `fields`.
 */
"use client";

import {
  ROWS_MAX_FILTER_VALUE_CHARS,
  type RowColumn,
  type RowFilterOp,
} from "@datacanvas/database-core";
import { Input } from "@/components/ui/input";
import { shapeOf, valueHint } from "./filtering";

export interface ConditionFields {
  value: string;
  list: string;
  low: string;
  high: string;
  path: string;
}

export const NO_FIELDS: ConditionFields = { value: "", list: "", low: "", high: "", path: "" };

export const FIELD_CLASS =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export function ConditionInputs({
  column,
  op,
  fields,
  onChange,
}: {
  column: RowColumn | undefined;
  op: RowFilterOp;
  fields: ConditionFields;
  onChange: (change: Partial<ConditionFields>) => void;
}) {
  const shape = shapeOf(op);
  const set = onChange;
  return (
    <>
      {shape === "one" || shape === "path" ? (
        <>
          {shape === "path" ? (
            <label className="flex min-w-40 flex-col gap-1 text-xs text-muted-foreground">
              Path
              <Input
                value={fields.path}
                autoComplete="off"
                spellCheck={false}
                placeholder="address.city or items.0.sku"
                onChange={(event) => set({ path: event.target.value })}
              />
            </label>
          ) : null}
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Value
            <Input
              value={fields.value}
              maxLength={ROWS_MAX_FILTER_VALUE_CHARS}
              autoComplete="off"
              spellCheck={false}
              placeholder={valueHint(column, op)}
              onChange={(event) => set({ value: event.target.value })}
            />
          </label>
        </>
      ) : null}

      {shape === "list" ? (
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
          Values, one per line
          <textarea
            value={fields.list}
            rows={3}
            autoComplete="off"
            spellCheck={false}
            className={`${FIELD_CLASS} h-auto py-1.5 font-mono`}
            onChange={(event) => set({ list: event.target.value })}
          />
        </label>
      ) : null}

      {shape === "two" ? (
        <>
          <label className="flex min-w-32 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            From (included)
            <Input
              value={fields.low}
              maxLength={ROWS_MAX_FILTER_VALUE_CHARS}
              autoComplete="off"
              spellCheck={false}
              placeholder={valueHint(column, "eq")}
              onChange={(event) => set({ low: event.target.value })}
            />
          </label>
          <label className="flex min-w-32 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            To (included)
            <Input
              value={fields.high}
              maxLength={ROWS_MAX_FILTER_VALUE_CHARS}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set({ high: event.target.value })}
            />
          </label>
        </>
      ) : null}
    </>
  );
}
