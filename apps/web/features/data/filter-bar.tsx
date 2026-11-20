/**
 * The filters of a table's rows: a button that opens a small panel (column, condition,
 * the values it takes, and how it combines), and the filters in force as removable chips.
 * Conditions are all required, except those put in the same group: any one of those is enough.
 *
 * What is typed here is a condition's value. It stays in this component and in the paging
 * state, is sent only in the body of a request, and is never stored.
 */
"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { ListFilter, X } from "lucide-react";
import type { RowColumn, RowFilter, RowFilterOp } from "@datacanvas/database-core";
import { ROWS_MAX_FILTERS } from "@datacanvas/database-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConditionInputs } from "./condition-inputs";
import { SavedShapes } from "./saved-shapes";
import {
  FILTER_OP_LABELS,
  GROUPS,
  canAddFilter,
  defaultOperator,
  describeFilter,
  emptyDraft,
  filterableColumns,
  groupLetter,
  makeFilter,
  operatorsFor,
  shapeOf,
} from "./filtering";

const SELECT_CLASS =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export function FilterBar({
  schema,
  table,
  columns,
  filters,
  onAdd,
  onRemove,
  onClear,
}: {
  /** The table, for its saved filter shapes. */
  schema: string;
  table: string;
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
  const [fields, setFields] = useState({
    value: "",
    list: "",
    low: "",
    high: "",
    path: "",
    group: 0,
  });
  const set = (change: Partial<typeof fields>) => setFields((was) => ({ ...was, ...change }));

  const usable = filterableColumns(columns);
  // Derived, not stored: a column that stopped being usable (hidden again) or an operator the new
  // column does not have falls back to the first one that is.
  const column = usable.find((c) => c.name === columnName) ?? usable[0];
  const operators = operatorsFor(column);
  const op = operators.includes(chosenOp) ? chosenOp : defaultOperator(column);
  const draft = { ...emptyDraft(column, op), ...fields };
  const check = canAddFilter(filters, draft);
  const full = !check.ok && filters.length >= ROWS_MAX_FILTERS;
  const shape = shapeOf(op);
  const typing =
    fields.value !== "" || fields.list !== "" || fields.low !== "" || fields.path !== "";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!check.ok || !column) return;
    onAdd(makeFilter(column, draft));
    // The group stays: the next condition is usually for the same group.
    set({ value: "", list: "", low: "", high: "", path: "" });
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
                  <span className="font-mono" title={filter.value ?? filter.values?.join(", ")}>
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

          <ConditionInputs column={column} op={op} fields={fields} onChange={set} />

          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Combine
            <select
              className={SELECT_CLASS}
              value={fields.group}
              onChange={(event) => set({ group: Number(event.target.value) })}
            >
              <option value={0}>Required (and)</option>
              {GROUPS.map((g) => (
                <option key={g} value={g}>
                  Any of group {groupLetter(g)} (or)
                </option>
              ))}
            </select>
          </label>

          <Button type="submit" size="sm" disabled={!check.ok}>
            Add filter
          </Button>

          {!check.ok && (full || typing || shape === "none") ? (
            <p role="status" className="basis-full text-xs text-muted-foreground">
              {check.reason}
            </p>
          ) : null}
        </form>
      ) : null}
      <SavedShapes
        key={`${schema}.${table}`}
        schema={schema}
        table={table}
        columns={columns}
        filters={filters}
        onUse={(made) => made.forEach(onAdd)}
      />
    </div>
  );
}
