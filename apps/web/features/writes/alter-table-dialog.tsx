/**
 * "Edit structure" for one table: choose an operation, fill its small form,
 * preview the exact statement with its warnings (locks, rewrites, scans,
 * renamed names), and apply. Drops need the table's name typed, and the
 * server refuses them while anything depends on what would be dropped
 * (decision 130); its sentence says what.
 */
"use client";

import { useState } from "react";
import type { ColumnInfo, ConstraintInfo, IndexInfo, TableRef } from "@datacanvas/database-core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { afterStructureChange } from "./after-structure-change";
import {
  ALTER_OPERATIONS,
  buildAlter,
  initialAlterState,
  type AlterOperation,
  type AlterState,
} from "./alter";
import { ChangeDialog, type ChangeRequest } from "./change-dialog";
import { ColumnFields, DefaultFields, SELECT_CLASS, TypeFields } from "./column-fields";
import { ForeignKeyFields } from "./foreign-key-fields";
import { CHANGE_LABEL } from "./structure";

export interface TableStructure {
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
}

const GROUPS = [...new Set(ALTER_OPERATIONS.map((o) => o.group))];

export function AlterTableDialog({
  connectionId,
  table,
  structure,
  open,
  onClose,
}: {
  connectionId: string;
  table: TableRef;
  structure: TableStructure;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {open ? (
          <AlterForm
            connectionId={connectionId}
            table={table}
            structure={structure}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ColumnSelect({
  columns,
  value,
  onChange,
  label = "Column",
}: {
  columns: string[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select
        aria-label={label}
        className={SELECT_CLASS}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose a column</option>
        {columns.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

function AlterForm({
  connectionId,
  table,
  structure,
  onClose,
}: {
  connectionId: string;
  table: TableRef;
  structure: TableStructure;
  onClose: () => void;
}) {
  const [state, setState] = useState<AlterState>(() => initialAlterState(table));
  const [request, setRequest] = useState<ChangeRequest | null>(null);
  const [tried, setTried] = useState(false);
  const columns = structure.columns.map((c) => c.name);
  const built = buildAlter(table, state);
  const set = (next: Partial<AlterState>) => setState((s) => ({ ...s, ...next }));
  const setColumnForm = (next: Partial<AlterState["columnForm"]>) =>
    setState((s) => ({ ...s, columnForm: { ...s.columnForm, ...next } }));
  const qualified = `${table.schema}.${table.name}`;
  const droppable = structure.constraints.filter((c) => c.kind !== "check");
  const droppableIndexes = structure.indexes.filter((i) => !i.primary);

  const chooseColumn = (name: string) => {
    const info = structure.columns.find((c) => c.name === name);
    set({ column: name, nullable: info?.nullable ?? true });
  };

  const toggle = (name: string, on: boolean) =>
    set({
      columns: on
        ? [...state.columns.filter((c) => c !== name), name]
        : state.columns.filter((c) => c !== name),
    });

  let body: React.ReactNode = null;
  switch (state.op) {
    case "add_column":
      body = <ColumnFields form={state.columnForm} index={1} onChange={setColumnForm} />;
      break;
    case "rename_column":
    case "rename_table":
      body = (
        <div className="flex flex-wrap items-end gap-2">
          {state.op === "rename_column" ? (
            <ColumnSelect columns={columns} value={state.column} onChange={chooseColumn} />
          ) : null}
          <div className="flex min-w-48 flex-col gap-1">
            <Label htmlFor="alter-new-name" className="text-xs">
              New name
            </Label>
            <Input
              id="alter-new-name"
              autoComplete="off"
              spellCheck={false}
              value={state.newName}
              onChange={(event) => set({ newName: event.target.value })}
            />
          </div>
        </div>
      );
      break;
    case "alter_column_type":
      body = (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-2">
            <ColumnSelect columns={columns} value={state.column} onChange={chooseColumn} />
            <TypeFields form={state.columnForm} onChange={setColumnForm} prefix="New" />
          </div>
          {state.column ? (
            <p className="text-xs text-muted-foreground">
              Now:{" "}
              <span className="font-mono">
                {structure.columns.find((c) => c.name === state.column)?.dataType}
              </span>
              . Only a change PostgreSQL can make on its own is allowed.
            </p>
          ) : null}
        </div>
      );
      break;
    case "set_nullable":
      body = (
        <div className="flex flex-wrap items-end gap-4">
          <ColumnSelect columns={columns} value={state.column} onChange={chooseColumn} />
          <fieldset className="flex gap-3 pb-2 text-xs">
            <legend className="sr-only">NULL</legend>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="alter-nullable"
                checked={state.nullable}
                onChange={() => set({ nullable: true })}
              />
              Can be NULL
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="alter-nullable"
                checked={!state.nullable}
                onChange={() => set({ nullable: false })}
              />
              NOT NULL
            </label>
          </fieldset>
        </div>
      );
      break;
    case "set_default":
      body = (
        <div className="flex flex-wrap items-end gap-2">
          <ColumnSelect columns={columns} value={state.column} onChange={chooseColumn} />
          <DefaultFields
            form={state.columnForm}
            onChange={setColumnForm}
            prefix="New"
            kinds={["none", "literal", "now", "current_date", "gen_random_uuid", "boolean"]}
          />
        </div>
      );
      break;
    case "add_primary_key":
    case "add_unique":
    case "create_index":
      body = (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs text-muted-foreground">Columns, in order of choosing</legend>
          <div className="flex flex-wrap gap-3">
            {columns.map((name) => (
              <label key={name} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={state.columns.includes(name)}
                  onChange={(event) => toggle(name, event.target.checked)}
                />
                <span className="font-mono">{name}</span>
              </label>
            ))}
          </div>
          {state.columns.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Order: <span className="font-mono">{state.columns.join(", ")}</span>
            </p>
          ) : null}
          {state.op === "create_index" ? (
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={state.unique}
                onChange={(event) => set({ unique: event.target.checked })}
              />
              Unique index
            </label>
          ) : null}
        </fieldset>
      );
      break;
    case "add_foreign_key":
      body = (
        <ForeignKeyFields
          connectionId={connectionId}
          form={state.foreignKey}
          index={1}
          localColumns={columns}
          self={{ schema: table.schema, name: table.name, columns }}
          onChange={(next) => set({ foreignKey: { ...state.foreignKey, ...next } })}
        />
      );
      break;
    case "drop_constraint":
      body = (
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Constraint</span>
          <select
            aria-label="Constraint"
            className={SELECT_CLASS}
            value={state.constraint}
            onChange={(event) => set({ constraint: event.target.value })}
          >
            <option value="">Choose a constraint</option>
            {droppable.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.columns.join(", ")})
              </option>
            ))}
          </select>
        </label>
      );
      break;
    case "drop_index":
      body = (
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Index</span>
          <select
            aria-label="Index"
            className={SELECT_CLASS}
            value={state.index}
            onChange={(event) => set({ index: event.target.value })}
          >
            <option value="">Choose an index</option>
            {droppableIndexes.map((i) => (
              <option key={i.name} value={i.name}>
                {i.name} ({i.columns.join(", ")})
              </option>
            ))}
          </select>
        </label>
      );
      break;
    case "drop_column":
    case "drop_table":
      body = (
        <div className="flex flex-col gap-2">
          {state.op === "drop_column" ? (
            <ColumnSelect columns={columns} value={state.column} onChange={chooseColumn} />
          ) : null}
          <p className="text-sm">
            {state.op === "drop_table"
              ? `This deletes ${qualified} and all of its rows.`
              : "This deletes the column and every value in it."}{" "}
            It cannot be undone. Nothing is dropped while a view, a foreign key or an index depends
            on it.
          </p>
          <div className="flex flex-col gap-1">
            <Label htmlFor="alter-confirm" className="text-xs">
              Type {table.name} to confirm
            </Label>
            <Input
              id="alter-confirm"
              autoComplete="off"
              spellCheck={false}
              value={state.confirm}
              onChange={(event) => set({ confirm: event.target.value })}
            />
          </div>
        </div>
      );
      break;
  }

  return (
    <>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (!built.ok) return;
          setRequest({ change: built.change, title: `${CHANGE_LABEL[state.op]}: ${qualified}` });
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit the structure of {qualified}</DialogTitle>
          <DialogDescription>
            One change at a time. You will see the exact statement and its effects before anything
            changes.
          </DialogDescription>
        </DialogHeader>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">What to change</span>
          <select
            aria-label="What to change"
            className={SELECT_CLASS}
            value={state.op}
            onChange={(event) => {
              setTried(false);
              setState(initialAlterState(table, event.target.value as AlterOperation));
            }}
          >
            {GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {ALTER_OPERATIONS.filter((o) => o.group === group).map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        {body}

        {tried && !built.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {built.problem}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Preview</Button>
        </DialogFooter>
      </form>

      <ChangeDialog
        connectionId={connectionId}
        request={request}
        onClose={() => setRequest(null)}
        onApplied={(_result, change) => {
          setRequest(null);
          onClose();
          void afterStructureChange(connectionId, change);
        }}
      />
    </>
  );
}
