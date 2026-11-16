/**
 * The filters of a table's rows: a button that opens a small panel (column, condition,
 * value), and the filters in force as removable chips. At most three, all required.
 *
 * What is typed here is a condition's value. It stays in this component and in the paging
 * state, is sent only in the body of a request, and is never stored.
 */
"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { ListFilter, X } from "lucide-react";
import type { RowColumn, RowFilter, RowFilterOp } from "@datacanvas/database-core";
import { ROWS_MAX_FILTER_VALUE_CHARS } from "@datacanvas/database-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FILTER_OP_LABELS,
  canAddFilter,
  defaultOperator,
  describeFilter,
  filterableColumns,
  makeFilter,
  needsValue,
  operatorsFor,
  valueHint,
} from "./filtering";

const SELECT_CLASS =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export function FilterBar({
  columns,
  filters,
  onAdd,
  onRemove,
  onClear,
}: {
  /** The columns of the page that was read: their kinds say what each can be asked. */
  columns: readonly RowColumn[];
  filters: readonly RowFilter[];
  onAdd: (filter: RowFilter) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
}) {
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [columnName, setColumnName] = useState("");
  const [chosenOp, setChosenOp] = useState<RowFilterOp>("eq");
  const [value, setValue] = useState("");

  const usable = filterableColumns(columns);
  // Derived, not stored: a column that stopped being usable (hidden again) or an operator the new
  // column does not have falls back to the first one that is.
  const column = usable.find((c) => c.name === columnName) ?? usable[0];
  const operators = operatorsFor(column);
  const op = operators.includes(chosenOp) ? chosenOp : defaultOperator(column);
  const check = canAddFilter(filters, { column, op, value });
  const full = !check.ok && filters.length >= 3;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!check.ok || !column) return;
    onAdd(makeFilter(column, op, value));
    setValue("");
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={toggleRef}
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((was) => !was)}
        >
          <ListFilter aria-hidden="true" />
          Filter
          {filters.length > 0 ? (
            <Badge variant="secondary" aria-label={`${filters.length} active`}>
              {filters.length}
            </Badge>
          ) : null}
        </Button>

        {filters.length > 0 ? (
          <ul aria-label="Active filters" className="flex flex-wrap items-center gap-2">
            {filters.map((filter, index) => {
              const text = describeFilter(filter);
              return (
                <li
                  key={`${index}-${text}`}
                  className="flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pr-0.5 pl-2.5 text-xs"
                >
                  <span className="font-mono" title={filter.value}>
                    {text}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove filter ${text}`}
                    onClick={() => {
                      onRemove(index);
                      toggleRef.current?.focus(); // the chip is gone: keep the keyboard where it was
                    }}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {filters.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              onClear();
              toggleRef.current?.focus();
            }}
          >
            Clear all
          </Button>
        ) : null}
      </div>

      {open ? (
        <form
          id={panelId}
          aria-label="Add a filter"
          onSubmit={submit}
          className="flex flex-wrap items-end gap-3 rounded-lg border p-3"
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Column
            <select
              className={SELECT_CLASS}
              value={column?.name ?? ""}
              onChange={(event) => setColumnName(event.target.value)}
            >
              {usable.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Condition
            <select
              className={SELECT_CLASS}
              value={op}
              onChange={(event) => setChosenOp(event.target.value as RowFilterOp)}
            >
              {operators.map((o) => (
                <option key={o} value={o}>
                  {FILTER_OP_LABELS[o]}
                </option>
              ))}
            </select>
          </label>

          {needsValue(op) ? (
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              Value
              <Input
                value={value}
                maxLength={ROWS_MAX_FILTER_VALUE_CHARS}
                autoComplete="off"
                spellCheck={false}
                placeholder={valueHint(column, op)}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
          ) : null}

          <Button type="submit" size="sm" disabled={!check.ok}>
            Add filter
          </Button>

          {!check.ok && (full || value !== "" || !needsValue(op)) ? (
            <p role="status" className="basis-full text-xs text-muted-foreground">
              {check.reason}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
