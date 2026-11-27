/**
 * Saved filter shapes, under the filter bar: save the filters in force as a shape (the columns and
 * conditions, never the values), and use one later by filling in its values again. Kept per table
 * in the browser (`filter-shapes.ts`).
 */
"use client";

import { useId, useState, type FormEvent } from "react";
import { Bookmark, Trash2 } from "lucide-react";
import { ROWS_MAX_FILTERS, type RowColumn, type RowFilter } from "@datacanvas/database-core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConditionInputs, NO_FIELDS, type ConditionFields } from "./condition-inputs";
import {
  FILTER_OP_LABELS,
  canAddFilter,
  emptyDraft,
  groupLetter,
  makeFilter,
  operatorsFor,
} from "./filtering";
import {
  MAX_SHAPE_NAME_CHARS,
  deleteShape,
  loadShapes,
  legacyShapes,
  moveLegacyShapes,
  type FilterScope,
  needsInput,
  saveShape,
  type FilterShape,
} from "./filter-shapes";

export function SavedShapes({
  scope,
  schema,
  table,
  columns,
  filters,
  onUse,
}: {
  scope: FilterScope;
  schema: string;
  table: string;
  columns: readonly RowColumn[];
  filters: readonly RowFilter[];
  /** The filters a shape made once its values were filled in (they replace none: they are added). */
  onUse: (filters: RowFilter[]) => void;
}) {
  const nameId = useId();
  // The Data section is drawn only in the browser, after its rows arrive, so storage can be read at once.
  const [shapes, setShapes] = useState<FilterShape[]>(() => loadShapes(scope, schema, table));
  const [canRecover, setCanRecover] = useState(
    () => scope.profileId !== null && legacyShapes(schema, table).length > 0,
  );
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [using, setUsing] = useState<FilterShape | null>(null);

  function save(event: FormEvent) {
    event.preventDefault();
    const saved = saveShape(scope, schema, table, name, filters);
    if (saved === null) {
      setNotice(
        "This could not be saved here (the name is empty, there are too many, or the browser refused).",
      );
      return;
    }
    setShapes(saved);
    setName("");
    setNotice(`Saved "${name.trim()}": the columns and conditions only, never the values.`);
  }

  if (shapes.length === 0 && filters.length === 0 && !canRecover) return null;

  return (
    <div className="flex flex-col gap-2">
      {filters.length > 0 ? (
        <form onSubmit={save} aria-label="Save filters" className="flex flex-wrap items-end gap-2">
          <label htmlFor={nameId} className="flex flex-col gap-1 text-xs text-muted-foreground">
            Save these filters as a shape
            <Input
              id={nameId}
              value={name}
              maxLength={MAX_SHAPE_NAME_CHARS}
              autoComplete="off"
              placeholder="Open orders this week"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={name.trim() === ""}>
            <Bookmark aria-hidden="true" />
            Save shape
          </Button>
          <span className="text-xs text-muted-foreground">
            {scope.profileId === null
              ? "Columns and conditions are kept until you disconnect or reload."
              : "Columns and conditions are saved for this connection."}
          </span>
        </form>
      ) : null}
      {canRecover ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              const recovered = moveLegacyShapes(scope, schema, table);
              if (recovered) setShapes(recovered);
              const hasRemaining = legacyShapes(schema, table).length > 0;
              setCanRecover(hasRemaining);
              setNotice(
                recovered
                  ? hasRemaining
                    ? "Previous filters moved. Filters with duplicate names or no room are still available to recover."
                    : "Previous filters moved to this connection."
                  : "These filters could not be moved. Check for duplicate names, room for more filters, or browser storage settings.",
              );
            }}
          >
            Move previous filters here
          </Button>
          <span className="text-xs text-muted-foreground">
            Previous filters for this table were shared across connections.
          </span>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}

      {shapes.length > 0 ? (
        <section aria-label="Saved filters" className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">Saved filters of this table</p>
          <ul className="flex flex-wrap gap-2">
            {shapes.map((shape) => (
              <li
                key={shape.name}
                className="flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pr-0.5 pl-2.5 text-xs"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setUsing(using?.name === shape.name ? null : shape)}
                  aria-expanded={using?.name === shape.name}
                >
                  {shape.name}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Delete the saved filters ${shape.name}`}
                  onClick={() => {
                    setShapes(deleteShape(scope, schema, table, shape.name));
                    if (using?.name === shape.name) setUsing(null);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {using ? (
        <FillIn
          key={using.name}
          shape={using}
          columns={columns}
          room={ROWS_MAX_FILTERS - filters.length}
          onUse={(made) => {
            onUse(made);
            setUsing(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** The values a shape asks for, one block per condition. */
function FillIn({
  shape,
  columns,
  room,
  onUse,
}: {
  shape: FilterShape;
  columns: readonly RowColumn[];
  room: number;
  onUse: (filters: RowFilter[]) => void;
}) {
  const [fields, setFields] = useState<ConditionFields[]>(() =>
    shape.conditions.map(() => NO_FIELDS),
  );
  const set = (i: number, change: Partial<ConditionFields>) =>
    setFields((was) => was.map((f, j) => (j === i ? { ...f, ...change } : f)));

  const drafts = shape.conditions.map((c, i) => {
    const column = columns.find((x) => x.name === c.column && !x.masked);
    return {
      c,
      column,
      draft: { ...emptyDraft(column, c.op), ...fields[i]!, group: c.group ?? 0 },
    };
  });
  const missing = drafts.find(({ column, c }) => !column || !operatorsFor(column).includes(c.op));
  const problem =
    missing !== undefined
      ? `The column ${missing.c.column} (or this condition on it) is not available here any more.`
      : shape.conditions.length > room
        ? `This shape has ${shape.conditions.length} conditions and only ${Math.max(0, room)} more fit. Remove some filters first.`
        : (
            drafts.map(({ draft }) => canAddFilter([], draft)).find((check) => !check.ok) as
              { ok: false; reason: string } | undefined
          )?.reason;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (problem) return;
    onUse(drafts.map(({ column, draft }) => makeFilter(column!, draft)));
  }

  return (
    <form
      onSubmit={submit}
      aria-label={`Fill in ${shape.name}`}
      className="flex flex-col gap-3 rounded-lg border p-3"
    >
      <p className="text-sm font-medium">{shape.name}</p>
      <ul className="flex flex-col gap-3">
        {drafts.map(({ c, column }, i) => (
          <li key={i} className="flex flex-wrap items-end gap-3">
            <span className="text-sm">
              <code className="font-mono">{c.column}</code> {FILTER_OP_LABELS[c.op]}
              {c.group !== undefined ? ` (any of ${groupLetter(c.group)})` : ""}
            </span>
            {needsInput(c) ? (
              <ConditionInputs
                column={column}
                op={c.op}
                fields={fields[i]!}
                onChange={(change) => set(i, change)}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={problem !== undefined}>
          Add these filters
        </Button>
        {problem ? (
          <p role="status" className="text-xs text-muted-foreground">
            {problem}
          </p>
        ) : null}
      </div>
    </form>
  );
}
