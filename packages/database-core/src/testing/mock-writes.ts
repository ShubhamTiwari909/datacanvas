/**
 * The write capability of the mock adapter, over the in-memory sample data.
 * Enough to test the write service and the routes end to end without a
 * database, and honest about the rules that matter there:
 *
 *  - a row is found by its key; an update applies only if the changed columns
 *    still hold what the person saw (`row_changed` otherwise); a row change
 *    touches exactly one row;
 *  - NOT NULL, primary keys and unique constraints are enforced on insert and
 *    update, with fixed messages that name structure, never a value;
 *  - statements are built with the same quoting as the real adapter, and
 *    every value is a parameter;
 *  - `create_table` and `drop_table` change the data; other structure
 *    changes are recorded (`appliedStructure`) but change nothing else.
 *
 * It is NOT a SQL engine: types are checked only for numbers, and the
 * statement text is plausible rather than what PostgreSQL would plan.
 */
import {
  DESTRUCTIVE_CHANGE_KINDS,
  isRowChange,
  type AppliedChange,
  type Change,
  type ChangeWarning,
  type ColumnDefinition,
  type ColumnType,
  type ColumnValue,
  type IncomingForeignKey,
  type KeyValue,
  type PlannedChange,
  type PlannedStatement,
  type RowChange,
  type StructureChange,
  type TableEditInfo,
} from "../changes.js";
import { DatabaseError } from "../errors.js";
import type { ColumnInfo, TableRef } from "../models.js";
import { quoteIdentifier, quoteQualified } from "../sql-text.js";
import type { MockDatabaseData } from "./ecommerce-fixture.js";

type Row = Record<string, string | null>;

const mapKeyOf = (ref: TableRef): string => `${ref.schema}.${ref.name}`;
const isNumeric = (type: string): boolean =>
  /^(smallint|integer|bigint|numeric|real|double precision)/.test(type);
const invalidChange = (message: string): DatabaseError =>
  new DatabaseError("invalid_change", { message });

/** The column type as SQL text (the allow-list, as the real adapter renders it). */
export function renderColumnType(type: ColumnType): string {
  let text: string = type.name;
  if (type.length !== undefined) text += `(${type.length})`;
  if (type.precision !== undefined) {
    text += type.scale !== undefined ? `(${type.precision},${type.scale})` : `(${type.precision})`;
  }
  return type.array ? `${text}[]` : text;
}

function renderDefault(column: ColumnDefinition): string {
  const type = renderColumnType(column.type);
  switch (column.default.kind) {
    case "none":
      return "";
    case "literal":
      return ` DEFAULT CAST('${column.default.value.replace(/'/g, "''")}' AS ${type})`;
    case "now":
      return " DEFAULT now()";
    case "current_date":
      return " DEFAULT CURRENT_DATE";
    case "gen_random_uuid":
      return " DEFAULT gen_random_uuid()";
    case "boolean":
      return ` DEFAULT ${column.default.value ? "true" : "false"}`;
  }
}

function renderColumn(column: ColumnDefinition): string {
  const identity = column.identity
    ? ` GENERATED ${column.identity === "always" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`
    : "";
  const notNull = column.nullable && !column.identity ? "" : " NOT NULL";
  return `${quoteIdentifier(column.name)} ${renderColumnType(column.type)}${identity}${notNull}${renderDefault(column)}`;
}

const columnList = (names: readonly string[]): string => names.map(quoteIdentifier).join(", ");

export class MockWrites {
  /** Structure changes that were applied but do not change the sample data. */
  readonly appliedStructure: StructureChange[] = [];

  constructor(private readonly data: MockDatabaseData) {}

  // --------------------------------------------------------------- describe ---

  describeForEdit(ref: TableRef): TableEditInfo {
    const table = this.data.tables.find((t) => t.schema === ref.schema && t.name === ref.name);
    if (!table) throw new DatabaseError("not_found");
    const mapKey = mapKeyOf(ref);
    const columns = Object.hasOwn(this.data.columns, mapKey) ? this.data.columns[mapKey]! : [];
    const key = this.keyColumns(mapKey);
    const reason =
      table.kind === "foreign_table"
        ? "foreign_table"
        : table.kind !== "table"
          ? "not_a_table"
          : key.length === 0
            ? "no_key"
            : null;
    return {
      table: { schema: ref.schema, name: ref.name },
      editable: reason === null,
      reason,
      key,
      columns: columns.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        nullable: c.nullable,
        hasDefault: c.defaultValue !== null,
        generated: false,
        identity: null,
        editable: !/^bytea\b/.test(c.dataType),
        inKey: key.includes(c.name),
      })),
      triggers: this.data.objects.triggers
        .filter((t) => t.schema === ref.schema && t.table === ref.name && t.state !== "disabled")
        .filter((t) => t.events.some((e) => e === "insert" || e === "update" || e === "delete"))
        .map((t) => t.name),
      rowSecurity: this.data.objects.rowSecurity.some(
        (r) => r.schema === ref.schema && r.table === ref.name,
      ),
      incomingForeignKeys: this.data.relationships
        .filter((r) => r.target.schema === ref.schema && r.target.table === ref.name)
        .map((r): IncomingForeignKey => ({
          name: r.name,
          from: { schema: r.source.schema, table: r.source.table, columns: [...r.source.columns] },
          columns: [...r.target.columns],
          onDelete: r.onDelete,
          onUpdate: r.onUpdate,
        })),
    };
  }

  // ---------------------------------------------------------------- preview ---

  previewChange(change: Change): PlannedChange {
    return isRowChange(change) ? this.previewRow(change) : this.previewStructure(change);
  }

  private previewRow(change: RowChange): PlannedChange {
    const info = this.describeForEdit(change.table);
    if (!info.editable) throw new DatabaseError("not_editable");
    const column = (name: string) => {
      const found = info.columns.find((c) => c.name === name);
      if (!found) throw invalidChange("A column in this change does not exist.");
      return found;
    };
    const typeOf = (name: string) => column(name).dataType;
    const values: (string | null)[] = [];
    const param = (value: string | null, type: string): string => {
      if (
        value !== null &&
        isNumeric(type) &&
        (value.trim() === "" || Number.isNaN(Number(value)))
      ) {
        throw new DatabaseError("invalid_value", {
          message: "A value is not valid for its column's type.",
        });
      }
      values.push(value);
      return `CAST($${values.length} AS ${type})`;
    };
    const keyWhere = (key: KeyValue[]): string => {
      const names = key.map((k) => k.column).sort();
      if (names.join("\0") !== [...info.key].sort().join("\0")) {
        throw invalidChange("A row must be found by every column of its key, and only those.");
      }
      return key
        .map((k) => `${quoteIdentifier(k.column)} = ${param(k.value, typeOf(k.column))}`)
        .join(" AND ");
    };
    const checkWritable = (list: ColumnValue[]) => {
      for (const v of list) {
        const c = column(v.column);
        if (!c.editable || c.generated) {
          throw invalidChange("A column in this change cannot be set here.");
        }
      }
    };
    const target = quoteQualified(change.table.schema, change.table.name);
    const warnings: ChangeWarning[] = [];
    if (info.triggers.length > 0) {
      warnings.push({
        code: "triggers",
        message: `Triggers on this table will run: ${info.triggers.join(", ")}.`,
      });
    }
    if (info.rowSecurity) {
      warnings.push({
        code: "row_security",
        message: "Row-level security is on for this table and may hide the row from this role.",
      });
    }

    let text: string;
    let effect: string;
    if (change.kind === "update_row") {
      checkWritable(change.set);
      const sets = change.set
        .map((v) => `${quoteIdentifier(v.column)} = ${param(v.value, typeOf(v.column))}`)
        .join(", ");
      const where = keyWhere(change.key);
      const seen = change.expected
        .map(
          (v) =>
            `CAST(${quoteIdentifier(v.column)} AS text) IS NOT DISTINCT FROM ${param(v.value, "text")}`,
        )
        .join(" AND ");
      text = `UPDATE ${target} SET ${sets} WHERE ${where} AND ${seen} RETURNING 1`;
      effect = `Changes ${change.set.length === 1 ? "1 column" : `${change.set.length} columns`} of one row in ${change.table.schema}.${change.table.name}.`;
      if (change.set.some((v) => info.key.includes(v.column)))
        this.referenced(info, "update", warnings);
    } else if (change.kind === "insert_row") {
      checkWritable(change.values);
      text =
        change.values.length === 0
          ? `INSERT INTO ${target} DEFAULT VALUES RETURNING 1`
          : `INSERT INTO ${target} (${columnList(change.values.map((v) => v.column))}) VALUES (${change.values
              .map((v) => param(v.value, typeOf(v.column)))
              .join(", ")}) RETURNING 1`;
      effect = `Adds one row to ${change.table.schema}.${change.table.name}.`;
    } else {
      text = `DELETE FROM ${target} WHERE ${keyWhere(change.key)} RETURNING 1`;
      effect = `Deletes one row from ${change.table.schema}.${change.table.name}.`;
      this.referenced(info, "delete", warnings);
      warnings.push({ code: "destructive", message: "A deleted row cannot be brought back." });
    }
    return {
      change,
      statements: [{ text, values }],
      expect: "one_row",
      category: "row",
      effect,
      warnings,
      destructive: change.kind === "delete_row",
    };
  }

  private referenced(info: TableEditInfo, event: "update" | "delete", warnings: ChangeWarning[]) {
    if (info.incomingForeignKeys.length === 0) return;
    const parts = info.incomingForeignKeys.map(
      (fk) =>
        `${fk.from.schema}.${fk.from.table}.${fk.from.columns.join(", ")} (ON ${event.toUpperCase()} ${(event === "delete" ? fk.onDelete : fk.onUpdate).replace("_", " ").toUpperCase()})`,
    );
    warnings.push({
      code: "referenced",
      message: `${info.incomingForeignKeys.length} foreign ${info.incomingForeignKeys.length === 1 ? "key points" : "keys point"} at this table: ${parts.join("; ")}.`,
    });
  }

  private previewStructure(change: StructureChange): PlannedChange {
    const statements: PlannedStatement[] = [];
    const warnings: ChangeWarning[] = [];
    const lock = () =>
      warnings.push({
        code: "lock",
        message:
          "Takes a lock that blocks reading and writing the table until the change is committed.",
      });

    if (change.kind === "create_table") {
      if (!this.data.schemas.some((s) => s.name === change.schema))
        throw new DatabaseError("not_found");
      if (this.data.tables.some((t) => t.schema === change.schema && t.name === change.name)) {
        throw new DatabaseError("already_exists");
      }
      const parts = change.columns.map(renderColumn);
      if (change.primaryKey.length > 0)
        parts.push(`PRIMARY KEY (${columnList(change.primaryKey)})`);
      for (const unique of change.unique) parts.push(`UNIQUE (${columnList(unique)})`);
      for (const fk of change.foreignKeys) {
        parts.push(
          `FOREIGN KEY (${columnList(fk.columns)}) REFERENCES ${quoteQualified(fk.references.schema, fk.references.table)} (${columnList(fk.references.columns)})`,
        );
      }
      statements.push({
        text: `CREATE TABLE ${quoteQualified(change.schema, change.name)} (\n  ${parts.join(",\n  ")}\n)`,
        values: [],
      });
      return this.structurePlan(
        change,
        statements,
        warnings,
        `Creates the table ${change.schema}.${change.name}.`,
      );
    }

    const target = quoteQualified(change.table.schema, change.table.name);
    const columns = this.columnsOf(change.table);
    const hasColumn = (name: string) => {
      if (!columns.some((c) => c.name === name))
        throw invalidChange("A column in this change does not exist.");
    };
    const alter = (rest: string) =>
      statements.push({ text: `ALTER TABLE ${target} ${rest}`, values: [] });
    let effect = `Changes the structure of ${change.table.schema}.${change.table.name}.`;

    switch (change.kind) {
      case "add_column":
        if (columns.some((c) => c.name === change.column.name))
          throw new DatabaseError("already_exists");
        alter(`ADD COLUMN ${renderColumn(change.column)}`);
        effect = `Adds the column ${change.column.name}.`;
        lock();
        break;
      case "rename_column":
        hasColumn(change.column);
        alter(`RENAME COLUMN ${quoteIdentifier(change.column)} TO ${quoteIdentifier(change.to)}`);
        warnings.push({
          code: "renamed",
          message: "Views, functions and code that use the old name stop working.",
        });
        lock();
        break;
      case "rename_table":
        alter(`RENAME TO ${quoteIdentifier(change.to)}`);
        warnings.push({
          code: "renamed",
          message: "Views, functions and code that use the old name stop working.",
        });
        lock();
        break;
      case "alter_column_type":
        hasColumn(change.column);
        alter(
          `ALTER COLUMN ${quoteIdentifier(change.column)} TYPE ${renderColumnType(change.type)}`,
        );
        warnings.push({ code: "rewrite", message: "Rewrites the whole table." });
        lock();
        break;
      case "set_nullable":
        hasColumn(change.column);
        alter(
          `ALTER COLUMN ${quoteIdentifier(change.column)} ${change.nullable ? "DROP" : "SET"} NOT NULL`,
        );
        if (!change.nullable)
          warnings.push({ code: "scan", message: "Reads every row to check that none is empty." });
        lock();
        break;
      case "set_default":
        hasColumn(change.column);
        alter(
          change.default.kind === "none"
            ? `ALTER COLUMN ${quoteIdentifier(change.column)} DROP DEFAULT`
            : `ALTER COLUMN ${quoteIdentifier(change.column)} SET${renderDefault({
                name: change.column,
                type: { name: "text" },
                nullable: true,
                default: change.default,
                identity: null,
                comment: null,
              })}`,
        );
        lock();
        break;
      case "add_primary_key":
      case "add_unique":
        change.columns.forEach(hasColumn);
        alter(
          `ADD ${change.kind === "add_primary_key" ? "PRIMARY KEY" : "UNIQUE"} (${columnList(change.columns)})`,
        );
        lock();
        break;
      case "add_foreign_key":
        change.foreignKey.columns.forEach(hasColumn);
        alter(
          `ADD FOREIGN KEY (${columnList(change.foreignKey.columns)}) REFERENCES ${quoteQualified(change.foreignKey.references.schema, change.foreignKey.references.table)} (${columnList(change.foreignKey.references.columns)})`,
        );
        warnings.push({ code: "scan", message: "Reads every row to check the foreign key." });
        lock();
        break;
      case "drop_constraint":
        alter(`DROP CONSTRAINT ${quoteIdentifier(change.constraint)}`);
        lock();
        break;
      case "create_index":
        change.columns.forEach(hasColumn);
        statements.push({
          text: `CREATE ${change.unique ? "UNIQUE " : ""}INDEX ON ${target} (${columnList(change.columns)})`,
          values: [],
        });
        warnings.push({
          code: "lock",
          message: "Blocks writes to the table while the index is built.",
        });
        break;
      case "drop_index":
        statements.push({
          text: `DROP INDEX ${quoteQualified(change.table.schema, change.index)}`,
          values: [],
        });
        lock();
        break;
      case "drop_column": {
        hasColumn(change.column);
        const mapKey = mapKeyOf(change.table);
        const used =
          (this.data.constraints[mapKey] ?? []).some((c) => c.columns.includes(change.column)) ||
          (this.data.indexes[mapKey] ?? []).some((i) => i.columns.includes(change.column)) ||
          this.data.relationships.some(
            (r) =>
              (r.source.schema === change.table.schema &&
                r.source.table === change.table.name &&
                r.source.columns.includes(change.column)) ||
              (r.target.schema === change.table.schema &&
                r.target.table === change.table.name &&
                r.target.columns.includes(change.column)),
          );
        if (used) throw new DatabaseError("has_dependents");
        alter(`DROP COLUMN ${quoteIdentifier(change.column)}`);
        effect = `Drops the column ${change.column} and its values.`;
        lock();
        break;
      }
      case "drop_table": {
        const referenced = this.data.relationships.some(
          (r) =>
            r.target.schema === change.table.schema &&
            r.target.table === change.table.name &&
            !(r.source.schema === change.table.schema && r.source.table === change.table.name),
        );
        if (referenced) throw new DatabaseError("has_dependents");
        statements.push({ text: `DROP TABLE ${target}`, values: [] });
        effect = `Drops the table ${change.table.schema}.${change.table.name} and all of its rows.`;
        break;
      }
    }
    if (DESTRUCTIVE_CHANGE_KINDS.includes(change.kind)) {
      warnings.push({ code: "destructive", message: "This cannot be undone." });
    }
    return this.structurePlan(change, statements, warnings, effect);
  }

  private structurePlan(
    change: StructureChange,
    statements: PlannedStatement[],
    warnings: ChangeWarning[],
    effect: string,
  ): PlannedChange {
    return {
      change,
      statements,
      expect: "any",
      category: "structure",
      effect,
      warnings,
      destructive: DESTRUCTIVE_CHANGE_KINDS.includes(change.kind),
    };
  }

  // ------------------------------------------------------------------ apply ---

  applyChange(plan: PlannedChange): AppliedChange {
    const change = plan.change;
    if (isRowChange(change)) return { rowCount: this.applyRow(change) };
    this.applyStructure(change);
    return { rowCount: 0 };
  }

  private applyRow(change: RowChange): number {
    const mapKey = mapKeyOf(change.table);
    const columns = this.columnsOf(change.table);
    const rows = (this.data.rows[mapKey] ??= []);
    const findIndex = (key: KeyValue[]) =>
      rows.findIndex((row) => key.every((k) => row[k.column] === k.value));

    if (change.kind === "delete_row") {
      const at = findIndex(change.key);
      if (at < 0) throw new DatabaseError("row_changed");
      rows.splice(at, 1);
      return 1;
    }
    if (change.kind === "update_row") {
      const at = findIndex(change.key);
      const row = at < 0 ? undefined : rows[at];
      if (!row || !change.expected.every((e) => (row[e.column] ?? null) === e.value)) {
        throw new DatabaseError("row_changed");
      }
      const next: Row = { ...row };
      for (const v of change.set) next[v.column] = v.value;
      this.checkRow(
        change.table,
        columns,
        next,
        rows.filter((_, i) => i !== at),
      );
      rows[at] = next;
      return 1;
    }
    const next: Row = {};
    for (const column of columns) {
      const given = change.values.find((v) => v.column === column.name);
      next[column.name] = given ? given.value : this.defaultFor(column, rows);
    }
    this.checkRow(change.table, columns, next, rows);
    rows.push(next);
    return 1;
  }

  private defaultFor(column: ColumnInfo, rows: Row[]): string | null {
    const definition = column.defaultValue ?? "";
    if (definition.startsWith("nextval(")) {
      return String(rows.reduce((max, row) => Math.max(max, Number(row[column.name] ?? 0)), 0) + 1);
    }
    if (definition === "now()") return "2026-11-16 12:00:00+00";
    return null;
  }

  /** NOT NULL, primary key and unique, with fixed messages that name structure only. */
  private checkRow(ref: TableRef, columns: ColumnInfo[], row: Row, others: Row[]): void {
    for (const column of columns) {
      if (!column.nullable && row[column.name] === null) {
        throw new DatabaseError("not_null_violation", {
          message: `${column.name} cannot be empty.`,
        });
      }
    }
    for (const constraint of this.data.constraints[mapKeyOf(ref)] ?? []) {
      if (constraint.kind !== "primary_key" && constraint.kind !== "unique") continue;
      const same = others.some((other) =>
        constraint.columns.every(
          (c) => row[c] !== null && row[c] !== undefined && other[c] === row[c],
        ),
      );
      if (same) {
        throw new DatabaseError("unique_violation", {
          message: `A row with the same value already exists (constraint ${constraint.name}).`,
        });
      }
    }
  }

  private applyStructure(change: StructureChange): void {
    if (change.kind === "create_table") {
      const mapKey = `${change.schema}.${change.name}`;
      if (this.data.tables.some((t) => t.schema === change.schema && t.name === change.name)) {
        throw new DatabaseError("already_exists");
      }
      this.data.tables.push({
        schema: change.schema,
        name: change.name,
        kind: "table",
        comment: change.comment,
        estimatedRowCount: 0,
      });
      this.data.columns[mapKey] = change.columns.map((c, i) => ({
        name: c.name,
        ordinalPosition: i + 1,
        dataType: renderColumnType(c.type),
        nullable: c.nullable && c.identity === null,
        defaultValue: null,
        comment: c.comment,
      }));
      this.data.constraints[mapKey] =
        change.primaryKey.length > 0
          ? [
              {
                name: `${change.name}_pkey`,
                kind: "primary_key",
                columns: [...change.primaryKey],
                definition: `PRIMARY KEY (${change.primaryKey.join(", ")})`,
              },
            ]
          : [];
      this.data.indexes[mapKey] = [];
      return;
    }
    if (change.kind === "drop_table") {
      const mapKey = mapKeyOf(change.table);
      const at = this.data.tables.findIndex(
        (t) => t.schema === change.table.schema && t.name === change.table.name,
      );
      if (at < 0) throw new DatabaseError("not_found");
      this.data.tables.splice(at, 1);
      for (const source of [
        this.data.columns,
        this.data.constraints,
        this.data.indexes,
        this.data.rows,
      ]) {
        delete (source as Record<string, unknown>)[mapKey];
      }
      return;
    }
    this.appliedStructure.push(change);
  }

  // -------------------------------------------------------------- internals ---

  private columnsOf(ref: TableRef): ColumnInfo[] {
    const mapKey = mapKeyOf(ref);
    if (!this.data.tables.some((t) => t.schema === ref.schema && t.name === ref.name)) {
      throw new DatabaseError("not_found");
    }
    return Object.hasOwn(this.data.columns, mapKey) ? this.data.columns[mapKey]! : [];
  }

  private keyColumns(mapKey: string): string[] {
    const primary = (this.data.constraints[mapKey] ?? []).find((c) => c.kind === "primary_key");
    if (primary) return [...primary.columns];
    const columns = this.data.columns[mapKey] ?? [];
    const unique = (this.data.indexes[mapKey] ?? []).find(
      (i) =>
        i.unique &&
        !/\sWHERE\s/i.test(i.definition ?? "") &&
        i.columns.every((name) => columns.find((c) => c.name === name)?.nullable === false),
    );
    return unique ? [...unique.columns] : [];
  }
}
