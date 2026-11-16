/**
 * "Edit structure": the operations on an existing table and how the form for
 * each becomes a structured change (decision 124). Pure, so it is tested
 * without a browser; the server checks every name and type again.
 */
import {
  isValidNewIdentifier,
  type StructureChange,
  type TableRef,
} from "@datacanvas/database-core";
import {
  columnDefaultOf,
  columnDefinitionOf,
  columnProblems,
  columnTypeOf,
  foreignKeyOf,
  newColumnForm,
  newForeignKeyForm,
  type ColumnForm,
  type ForeignKeyForm,
} from "./structure";

export type AlterOperation = Exclude<StructureChange["kind"], "create_table">;

export const ALTER_OPERATIONS: { op: AlterOperation; label: string; group: string }[] = [
  { op: "add_column", label: "Add a column", group: "Columns" },
  { op: "rename_column", label: "Rename a column", group: "Columns" },
  { op: "alter_column_type", label: "Change a column's type", group: "Columns" },
  { op: "set_nullable", label: "Allow or forbid NULL", group: "Columns" },
  { op: "set_default", label: "Set or remove a default", group: "Columns" },
  { op: "drop_column", label: "Drop a column", group: "Columns" },
  { op: "add_primary_key", label: "Add a primary key", group: "Keys and indexes" },
  { op: "add_unique", label: "Add a unique constraint", group: "Keys and indexes" },
  { op: "add_foreign_key", label: "Add a foreign key", group: "Keys and indexes" },
  { op: "drop_constraint", label: "Drop a constraint", group: "Keys and indexes" },
  { op: "create_index", label: "Create an index", group: "Keys and indexes" },
  { op: "drop_index", label: "Drop an index", group: "Keys and indexes" },
  { op: "rename_table", label: "Rename the table", group: "Table" },
  { op: "drop_table", label: "Drop the table", group: "Table" },
];

export interface AlterState {
  op: AlterOperation;
  /** The existing column the operation is about. */
  column: string;
  /** A new name (rename column or table). */
  newName: string;
  /** The table's name, typed to confirm a drop. */
  confirm: string;
  /** A new column, or the new type or default of an existing one. */
  columnForm: ColumnForm;
  nullable: boolean;
  /** Columns of a primary key, unique constraint or index. */
  columns: string[];
  unique: boolean;
  constraint: string;
  index: string;
  foreignKey: ForeignKeyForm;
}

export function initialAlterState(table: TableRef, op: AlterOperation = "add_column"): AlterState {
  return {
    op,
    column: "",
    newName: "",
    confirm: "",
    columnForm: newColumnForm(),
    nullable: true,
    columns: [],
    unique: false,
    constraint: "",
    index: "",
    foreignKey: newForeignKeyForm(table.schema),
  };
}

export type AlterBuild = { ok: true; change: StructureChange } | { ok: false; problem: string };

const needColumn: AlterBuild = { ok: false, problem: "Choose a column." };

/** The change for the form, or the first thing missing from it. Problems never repeat what was typed. */
export function buildAlter(table: TableRef, state: AlterState): AlterBuild {
  const ref = { schema: table.schema, name: table.name };
  switch (state.op) {
    case "add_column": {
      const problems = columnProblems(state.columnForm);
      if (problems.length > 0) return { ok: false, problem: problems[0]! };
      return {
        ok: true,
        change: { kind: "add_column", table: ref, column: columnDefinitionOf(state.columnForm) },
      };
    }
    case "rename_column":
      if (state.column === "") return needColumn;
      if (!isValidNewIdentifier(state.newName))
        return { ok: false, problem: "Type a new name: at most 63 bytes, no spaces at the ends." };
      return {
        ok: true,
        change: { kind: "rename_column", table: ref, column: state.column, to: state.newName },
      };
    case "rename_table":
      if (!isValidNewIdentifier(state.newName))
        return { ok: false, problem: "Type a new name: at most 63 bytes, no spaces at the ends." };
      return { ok: true, change: { kind: "rename_table", table: ref, to: state.newName } };
    case "alter_column_type": {
      if (state.column === "") return needColumn;
      const problems = columnProblems({ ...state.columnForm, name: state.column, identity: null });
      if (problems.length > 0) return { ok: false, problem: problems[0]! };
      return {
        ok: true,
        change: {
          kind: "alter_column_type",
          table: ref,
          column: state.column,
          type: columnTypeOf(state.columnForm),
        },
      };
    }
    case "set_nullable":
      if (state.column === "") return needColumn;
      return {
        ok: true,
        change: {
          kind: "set_nullable",
          table: ref,
          column: state.column,
          nullable: state.nullable,
        },
      };
    case "set_default":
      if (state.column === "") return needColumn;
      return {
        ok: true,
        change: {
          kind: "set_default",
          table: ref,
          column: state.column,
          default: columnDefaultOf(state.columnForm),
        },
      };
    case "add_primary_key":
    case "add_unique":
      if (state.columns.length === 0) return { ok: false, problem: "Choose at least one column." };
      return { ok: true, change: { kind: state.op, table: ref, columns: [...state.columns] } };
    case "create_index":
      if (state.columns.length === 0) return { ok: false, problem: "Choose at least one column." };
      return {
        ok: true,
        change: {
          kind: "create_index",
          table: ref,
          columns: [...state.columns],
          unique: state.unique,
        },
      };
    case "add_foreign_key": {
      const fk = state.foreignKey;
      if (fk.columns.some((c) => c === ""))
        return { ok: false, problem: "Choose the columns of this table." };
      if (fk.table === "") return { ok: false, problem: "Choose the table it points at." };
      if (fk.referenced.some((c) => c === ""))
        return { ok: false, problem: "Choose the columns it points at." };
      return {
        ok: true,
        change: { kind: "add_foreign_key", table: ref, foreignKey: foreignKeyOf(fk) },
      };
    }
    case "drop_constraint":
      if (state.constraint === "") return { ok: false, problem: "Choose a constraint." };
      return {
        ok: true,
        change: { kind: "drop_constraint", table: ref, constraint: state.constraint },
      };
    case "drop_index":
      if (state.index === "") return { ok: false, problem: "Choose an index." };
      return { ok: true, change: { kind: "drop_index", table: ref, index: state.index } };
    case "drop_column":
      if (state.column === "") return needColumn;
      if (state.confirm !== table.name)
        return { ok: false, problem: "Type the table's name to confirm." };
      return {
        ok: true,
        change: { kind: "drop_column", table: ref, column: state.column, confirm: state.confirm },
      };
    case "drop_table":
      if (state.confirm !== table.name)
        return { ok: false, problem: "Type the table's name to confirm." };
      return { ok: true, change: { kind: "drop_table", table: ref, confirm: state.confirm } };
  }
}
