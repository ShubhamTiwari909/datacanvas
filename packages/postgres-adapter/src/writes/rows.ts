/**
 * Row changes (update, insert, delete of ONE row), decision 124 and plan 6.4.
 *
 * The statements are one fixed shape each, built from catalog names (quoted)
 * and type names from `format_type` (already valid SQL), with EVERY value a
 * bound parameter cast in the database:
 *
 *   UPDATE "s"."t" SET "a" = CAST($1 AS <type of a, without modifier>)
 *   WHERE "k" = CAST($2 AS <type of k>)
 *     AND CAST("a" AS text) IS NOT DISTINCT FROM CAST($3 AS text)   -- what the person saw
 *   RETURNING 1
 *
 * The value is cast to the type WITHOUT its modifier, so that the assignment
 * to the column enforces it: an explicit cast to `varchar(5)` would cut a long
 * value silently, an assignment refuses it. The conflict check compares the
 * text form, which is exactly what the data viewer showed.
 */
import {
  DatabaseError,
  quoteIdentifier,
  quoteQualified,
  type ChangeWarning,
  IMPORT_BATCH_ROWS,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
  MAX_BULK_ROWS,
  type ColumnValue,
  type DeleteRowChange,
  type DeleteRowsChange,
  type InsertRowsChange,
  type UpdateRowsChange,
  type IncomingForeignKey,
  type InsertRowChange,
  type KeyValue,
  type NotEditableReason,
  type PlannedChange,
  type PlannedStatement,
  type RowChange,
  type TableEditInfo,
  type TableRef,
  type UpdateRowChange,
} from "@datacanvas/database-core";
import { findRowKey, findRowSecurity } from "../introspection/rows.js";
import type { Queryable } from "../introspection/types.js";
import {
  TRIGGER_EVENT,
  listCascadeChain,
  listConstraints,
  listIncomingForeignKeys,
  listTriggers,
  loadTable,
  type CatalogColumn,
  type CatalogTable,
} from "./catalog.js";
import { guardRelation } from "./guard.js";
import { displayName, invalidChange, listWords, onDeleteWords, onUpdateWords } from "./sql.js";

// --------------------------------------------------------------- builders ---

/** A column with the type its value is cast to. */
export interface TypedValue {
  column: string;
  /** The type without its modifier (`format_type(oid, NULL)`). */
  castType: string;
  value: string | null;
}

/** `"k" = CAST($n AS type)` for each key column, `$n` counting on from `start`. */
function keyCondition(key: readonly TypedValue[], start: number): string {
  return key
    .map((k, i) => `${quoteIdentifier(k.column)} = CAST($${start + i} AS ${k.castType})`)
    .join(" AND ");
}

export function buildUpdateRow(
  table: TableRef,
  key: readonly TypedValue[],
  set: readonly TypedValue[],
  expected: readonly ColumnValue[],
): PlannedStatement {
  const values: (string | null)[] = [];
  const assignments = set.map((s) => {
    values.push(s.value);
    return `${quoteIdentifier(s.column)} = CAST($${values.length} AS ${s.castType})`;
  });
  const where = keyCondition(key, values.length + 1);
  values.push(...key.map((k) => k.value));
  // The conflict check: every changed column still holds what the person saw.
  const checks = set.map((s) => {
    const seen = expected.find((e) => e.column === s.column);
    values.push(seen ? seen.value : null);
    return `CAST(${quoteIdentifier(s.column)} AS text) IS NOT DISTINCT FROM CAST($${values.length} AS text)`;
  });
  return {
    text: `UPDATE ${quoteQualified(table.schema, table.name)} SET ${assignments.join(", ")} WHERE ${[where, ...checks].join(" AND ")} RETURNING 1`,
    values,
  };
}

export function buildInsertRow(table: TableRef, values: readonly TypedValue[]): PlannedStatement {
  const target = quoteQualified(table.schema, table.name);
  if (values.length === 0) {
    return { text: `INSERT INTO ${target} DEFAULT VALUES RETURNING 1`, values: [] };
  }
  const columns = values.map((v) => quoteIdentifier(v.column)).join(", ");
  const casts = values.map((v, i) => `CAST($${i + 1} AS ${v.castType})`).join(", ");
  return {
    text: `INSERT INTO ${target} (${columns}) VALUES (${casts}) RETURNING 1`,
    values: values.map((v) => v.value),
  };
}

/**
 * Does a row still hold what the person saw? One fixed shape, used by a bulk change to find the rows that changed
 * since they were loaded (at preview, in the read-only transaction, before anything is written):
 *
 *   SELECT tableoid::text || ':' || ctid::text AS row_id FROM "s"."t" WHERE "k" = CAST($1 AS <type of k>)
 *     AND CAST("a" AS text) IS NOT DISTINCT FROM CAST($2 AS text) LIMIT 1
 */
export function buildRowStillHolds(
  table: TableRef,
  key: readonly TypedValue[],
  expected: ReadonlyArray<{ column: string; value: string | null }>,
): PlannedStatement {
  const values: (string | null)[] = key.map((k) => k.value);
  const checks = expected.map((e) => {
    values.push(e.value);
    return `CAST(${quoteIdentifier(e.column)} AS text) IS NOT DISTINCT FROM CAST($${values.length} AS text)`;
  });
  return {
    // The row's physical identity (the partition's own table and its position) says whether two keys found one row.
    text: `SELECT tableoid::text || ':' || ctid::text AS row_id FROM ${quoteQualified(table.schema, table.name)} WHERE ${[keyCondition(key, 1), ...checks].join(" AND ")} LIMIT 1`,
    values,
  };
}

export function buildDeleteRow(table: TableRef, key: readonly TypedValue[]): PlannedStatement {
  return {
    text: `DELETE FROM ${quoteQualified(table.schema, table.name)} WHERE ${keyCondition(key, 1)} RETURNING 1`,
    values: key.map((k) => k.value),
  };
}

// ------------------------------------------------------------ edit info ---

function notEditableReason(table: CatalogTable): NotEditableReason | null {
  if (table.relkind === "f") return "foreign_table";
  if (table.relkind !== "r" && table.relkind !== "p") return "not_a_table";
  if (table.isPartition) return "partition_of_other";
  return null;
}

const NOT_EDITABLE_MESSAGE: Record<NotEditableReason, string> = {
  not_a_table: "Only the rows of a table can be changed here, not those of a view.",
  foreign_table: "The rows of a foreign table live in another database and cannot be changed here.",
  partition_of_other: "This table is a partition. Change its rows through the partitioned table.",
  no_key:
    "This table has no primary key or unique index on NOT NULL columns, so a row cannot be found safely. Its rows cannot be changed here.",
  not_found: "The table does not exist.",
};

/** Can a person type a value for this column? Not for generated columns, GENERATED ALWAYS identities or bytea. */
function columnEditable(column: CatalogColumn): boolean {
  return !column.generated && column.identity !== "always" && !column.isBytea;
}

export async function describeForEdit(db: Queryable, ref: TableRef): Promise<TableEditInfo> {
  const table = await loadTable(db, ref);
  if (!table) throw new DatabaseError("not_found");
  let reason = notEditableReason(table);
  const order = reason === null ? await findRowKey(db, ref) : null;
  const key = order && order.kind !== "none" ? order.columns : [];
  if (reason === null && key.length === 0) reason = "no_key";
  const isTable = table.relkind === "r" || table.relkind === "p";
  const rowSecurity = isTable ? (await findRowSecurity(db, ref)) === "applies" : false;
  return {
    table: { schema: ref.schema, name: ref.name },
    editable: reason === null,
    reason,
    key,
    columns: table.columns.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      nullable: !c.notNull,
      hasDefault: c.hasDefault || c.identity !== null || c.generated,
      generated: c.generated || c.identity === "always",
      identity: c.identity,
      editable: columnEditable(c),
      inKey: key.includes(c.name),
    })),
    triggers: isTable
      ? await listTriggers(
          db,
          table.oid,
          TRIGGER_EVENT.insert | TRIGGER_EVENT.update | TRIGGER_EVENT.delete,
        )
      : [],
    rowSecurity,
    incomingForeignKeys: isTable ? await listIncomingForeignKeys(db, table.oid) : [],
  };
}

// --------------------------------------------------------------- planning ---

interface EditableTable {
  table: CatalogTable;
  key: string[];
}

async function requireEditable(db: Queryable, ref: TableRef): Promise<EditableTable> {
  const table = await loadTable(db, ref);
  if (!table) throw new DatabaseError("not_found");
  const reason = notEditableReason(table);
  if (reason) throw new DatabaseError("not_editable", { message: NOT_EDITABLE_MESSAGE[reason] });
  const order = await findRowKey(db, ref);
  if (order.kind === "none") {
    throw new DatabaseError("not_editable", { message: NOT_EDITABLE_MESSAGE.no_key });
  }
  return { table, key: order.columns };
}

function findColumn(table: CatalogTable, name: string): CatalogColumn {
  const column = table.columns.find((c) => c.name === name);
  if (!column) throw invalidChange(`The column ${name} does not exist (any more).`);
  return column;
}

/** The person gives a value for this column: refuse what the database fills or what cannot be typed. */
function requireWritable(column: CatalogColumn): void {
  if (column.generated) {
    throw invalidChange(`${column.name} is a generated column: the database computes it.`);
  }
  if (column.identity === "always") {
    throw invalidChange(`${column.name} is filled by the database (GENERATED ALWAYS AS IDENTITY).`);
  }
  if (column.isBytea) {
    throw invalidChange(`${column.name} holds binary data (bytea), which cannot be edited here.`);
  }
}

/** The key, exactly the table's key columns (in key order), with their types. */
function typedKey(
  table: CatalogTable,
  keyColumns: readonly string[],
  key: readonly KeyValue[],
): TypedValue[] {
  const given = new Map(key.map((k) => [k.column, k.value]));
  if (given.size !== keyColumns.length || !keyColumns.every((c) => given.has(c))) {
    throw invalidChange(`A row must be found by its whole key (${listWords(keyColumns)}).`);
  }
  return keyColumns.map((name) => ({
    column: name,
    castType: findColumn(table, name).castType,
    value: given.get(name) ?? "",
  }));
}

/**
 * Check, without changing anything, that each value is accepted by its type.
 * Each try runs in a savepoint of the read-only transaction, so a refused value
 * does not end the transaction. The database's message (which contains the
 * value) is dropped; the error names the column and its type only.
 */
async function checkValues(
  db: Queryable,
  values: readonly TypedValue[],
  fullType: (column: string) => string,
): Promise<void> {
  for (const v of values) {
    if (v.value === null) continue;
    const type = fullType(v.column);
    await db.query("SAVEPOINT dc_value_check");
    try {
      // An explicit CAST to varchar(n) or char(n) cuts a longer value silently, where the assignment to the column
      // refuses it (except for spaces at the end): compare the length to see whether this cast cut anything.
      const bounded = /^(?:character varying|character|varchar|char|bpchar)\s*\(\d+\)$/i.test(type);
      if (bounded) {
        const checked = await db.query(
          `SELECT char_length(CAST($1 AS ${type})) < char_length(rtrim($1)) AS cut`,
          [v.value],
        );
        if ((checked.rows[0] as { cut?: unknown } | undefined)?.cut === true) {
          throw new DatabaseError("invalid_value", {
            message: `The value for ${v.column} is too long for ${type}.`,
          });
        }
      } else {
        await db.query(`SELECT CAST($1 AS ${type})`, [v.value]);
      }
      await db.query("RELEASE SAVEPOINT dc_value_check");
    } catch (error) {
      await db.query("ROLLBACK TO SAVEPOINT dc_value_check");
      const code =
        typeof error === "object" && error !== null
          ? (error as { code?: unknown }).code
          : undefined;
      if (typeof code === "string" && code.startsWith("22")) {
        throw new DatabaseError("invalid_value", {
          message: `The value for ${v.column} is not a valid ${type}.`,
          cause: error,
        });
      }
      // A domain's own rule (its CHECK or NOT NULL) refused the value.
      if (code === "23514" || code === "23502") {
        throw new DatabaseError("check_violation", {
          message: `The value for ${v.column} breaks a rule of its type (${type}).`,
          cause: error,
        });
      }
      throw error;
    }
  }
}

function referencedWarning(
  fks: readonly IncomingForeignKey[],
  action: "delete" | "update",
  columns: readonly string[] | null,
): ChangeWarning | null {
  const relevant = fks.filter(
    (fk) => columns === null || fk.columns.some((c) => columns.includes(c)),
  );
  if (relevant.length === 0) return null;
  const parts = relevant.map((fk) => {
    const from = `${displayName(fk.from.schema, fk.from.table)}.${fk.from.columns.join(", ")}`;
    return action === "delete"
      ? `${from} (on delete: ${onDeleteWords(fk.onDelete)})`
      : `${from} (on update: ${onUpdateWords(fk.onUpdate)})`;
  });
  const subject = action === "delete" ? "this row" : "this row's key";
  return {
    code: "referenced",
    message: `${relevant.length === 1 ? "A foreign key points" : `${relevant.length} foreign keys point`} at ${subject}: ${parts.join("; ")}.`,
  };
}

async function rowWarnings(
  db: Queryable,
  ref: TableRef,
  table: CatalogTable,
  event: number,
): Promise<ChangeWarning[]> {
  const warnings: ChangeWarning[] = [];
  const triggers = await listTriggers(db, table.oid, event);
  if (triggers.length > 0) {
    warnings.push({
      code: "triggers",
      message: `${triggers.length === 1 ? "A trigger" : `${triggers.length} triggers`} on this table will run: ${listWords(triggers)}.`,
    });
  }
  if ((await findRowSecurity(db, ref)) === "applies") {
    warnings.push({
      code: "row_security",
      message:
        "Row-level security applies to this role: if a policy hides the row or refuses the change, nothing is written.",
    });
  }
  return warnings;
}

async function planUpdate(db: Queryable, change: UpdateRowChange): Promise<PlannedChange> {
  const { table, key } = await requireEditable(db, change.table);
  const typed = typedKey(table, key, change.key);
  const set = change.set.map((s): TypedValue => {
    const column = findColumn(table, s.column);
    requireWritable(column);
    return { column: column.name, castType: column.castType, value: s.value };
  });
  if (set.length === 0) throw invalidChange("Nothing to change.");
  const fullType = (name: string): string => findColumn(table, name).dataType;
  await checkValues(db, typed, (name) => findColumn(table, name).castType);
  await checkValues(db, set, fullType);

  const warnings = await rowWarnings(db, change.table, table, TRIGGER_EVENT.update);
  const names = set.map((s) => s.column);
  // Any changed column that a foreign key points at (the row's key, or another unique key) can
  // trigger that key's ON UPDATE action, so all of them are compared, not only the key.
  const referenced = referencedWarning(
    await listIncomingForeignKeys(db, table.oid),
    "update",
    names,
  );
  if (referenced) warnings.push(referenced);
  return {
    change,
    statements: [buildUpdateRow(change.table, typed, set, change.expected)],
    expect: "one_row",
    category: "row",
    effect: `Changes ${names.length === 1 ? "one column" : `${names.length} columns`} (${listWords(names)}) of one row of ${displayName(change.table.schema, change.table.name)}, found by its key, if ${names.length === 1 ? "it still holds" : "they still hold"} the value${names.length === 1 ? "" : "s"} you saw.`,
    warnings,
    destructive: false,
    guard: { relations: [guardRelation(table, [...key, ...names], "row_exclusive")] },
  };
}

/**
 * What happens to the columns an insert leaves out, truthfully: a column with a
 * default gets it, one filled by the database (identity or generated) is
 * computed, and one with neither gets NULL.
 */
function omittedWords(table: CatalogTable, given: readonly TypedValue[]): string {
  const left = table.columns.filter((c) => !given.some((g) => g.column === c.name));
  const filled = left.filter((c) => c.generated || c.identity !== null).map((c) => c.name);
  const defaulted = left
    .filter((c) => !c.generated && c.identity === null && c.hasDefault)
    .map((c) => c.name);
  const empty = left
    .filter((c) => !c.generated && c.identity === null && !c.hasDefault)
    .map((c) => c.name);
  const parts: string[] = [];
  if (defaulted.length > 0)
    parts.push(`${listWords(defaulted)} get${defaulted.length === 1 ? "s its" : " their"} default`);
  if (filled.length > 0)
    parts.push(
      `${listWords(filled)} ${filled.length === 1 ? "is" : "are"} filled in by the database`,
    );
  if (empty.length > 0)
    parts.push(
      `${listWords(empty)} ${empty.length === 1 ? "has" : "have"} no default and will be NULL`,
    );
  return parts.length > 0 ? `; ${parts.join("; ")}` : "";
}

async function planInsert(db: Queryable, change: InsertRowChange): Promise<PlannedChange> {
  const { table } = await requireEditable(db, change.table);
  const values = change.values.map((v): TypedValue => {
    const column = findColumn(table, v.column);
    requireWritable(column);
    return { column: column.name, castType: column.castType, value: v.value };
  });
  await checkValues(db, values, (name) => findColumn(table, name).dataType);
  const warnings = await rowWarnings(db, change.table, table, TRIGGER_EVENT.insert);
  return {
    change,
    statements: [buildInsertRow(change.table, values)],
    expect: "one_row",
    category: "row",
    effect: `Adds one row to ${displayName(change.table.schema, change.table.name)}${omittedWords(table, values)}.`,
    warnings,
    destructive: false,
    guard: {
      relations: [
        guardRelation(
          table,
          values.map((v) => v.column),
          "row_exclusive",
        ),
      ],
    },
  };
}

async function planDelete(db: Queryable, change: DeleteRowChange): Promise<PlannedChange> {
  const { table, key } = await requireEditable(db, change.table);
  const typed = typedKey(table, key, change.key);
  await checkValues(db, typed, (name) => findColumn(table, name).castType);
  const warnings = await rowWarnings(db, change.table, table, TRIGGER_EVENT.delete);
  const referenced = referencedWarning(
    await listIncomingForeignKeys(db, table.oid),
    "delete",
    null,
  );
  const chain = await listCascadeChain(db, table.oid);
  if (referenced && chain.length > 0) {
    referenced.message += ` The cascade goes further down: rows of ${listWords(chain)} can be deleted too.`;
  } else if (chain.length > 0) {
    warnings.push({
      code: "referenced",
      message: `The cascade goes further down: rows of ${listWords(chain)} can be deleted too.`,
    });
  }
  if (referenced) warnings.push(referenced);
  warnings.push({ code: "destructive", message: "A deleted row cannot be brought back." });
  return {
    change,
    statements: [buildDeleteRow(change.table, typed)],
    expect: "one_row",
    category: "row",
    effect: `Deletes one row of ${displayName(change.table.schema, change.table.name)}, found by its key.`,
    warnings,
    destructive: true,
    guard: { relations: [guardRelation(table, key, "row_exclusive")] },
  };
}

// ------------------------------------------------------------------- bulk ---

/** A bulk change refuses a row named twice, by its key as the table knows it (the order of the columns does not matter). */
function distinctRows(keys: readonly (readonly TypedValue[])[]): void {
  const seen = new Set(keys.map((k) => JSON.stringify(k.map((v) => [v.column, v.value]))));
  if (seen.size !== keys.length) throw invalidChange("A row is listed twice.");
}

/**
 * The rows of a bulk change that still hold what the person saw (and still exist), and the positions of those that
 * do not. All the questions run in one savepoint: a key value that does not fit its type ends them with a fixed
 * message that names no value.
 */
async function splitByCurrent(
  db: Queryable,
  table: TableRef,
  rows: ReadonlyArray<{
    key: readonly TypedValue[];
    expected: ReadonlyArray<{ column: string; value: string | null }>;
  }>,
): Promise<{ kept: number[]; skipped: number[] }> {
  // A NUL cannot be in any PostgreSQL text: say so about the value it is in, instead of letting the cast of a value
  // that was seen (compared as text) end in the message about the type of the key.
  if (rows.some((r) => r.expected.some((e) => e.value !== null && e.value.includes("\u0000")))) {
    throw invalidChange("A value contains a NUL character, which PostgreSQL cannot store.");
  }
  const kept: number[] = [];
  const skipped: number[] = [];
  const identities = new Set<string>();
  let repeated = false;
  await db.query("SAVEPOINT dc_bulk_check");
  try {
    for (let i = 0; i < rows.length; i++) {
      const statement = buildRowStillHolds(table, rows[i]!.key, rows[i]!.expected);
      const { rows: found } = await db.query<{ row_id: string }>(statement.text, statement.values);
      if (found.length === 0) {
        skipped.push(i);
        continue;
      }
      // Two keys written differently ('1' and '01') can find the same row: that would change it twice.
      if (identities.has(found[0]!.row_id)) repeated = true;
      identities.add(found[0]!.row_id);
      kept.push(i);
    }
    await db.query("RELEASE SAVEPOINT dc_bulk_check");
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT dc_bulk_check");
    const code =
      typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (typeof code === "string" && code.startsWith("22")) {
      throw new DatabaseError("invalid_value", {
        message: "A value that finds a row is not valid for the type of its key column.",
        cause: error,
      });
    }
    throw error;
  }
  if (repeated) throw invalidChange("A row is listed twice.");
  return { kept, skipped };
}

/** The warnings of a row change, for several rows: a trigger runs for each of them. */
async function bulkWarnings(
  db: Queryable,
  ref: TableRef,
  table: CatalogTable,
  event: number,
  rows: number,
  /** For an import: the number of batches (one statement each). A bulk update or delete is one statement per row. */
  batches?: number,
): Promise<ChangeWarning[]> {
  const warnings = await rowWarnings(db, ref, table, event);
  const count = rows.toLocaleString("en-US");
  const how =
    batches === undefined
      ? `They run for each of the ${count} rows.`
      : `A trigger that runs for each row runs for each of the ${count} rows; one that runs for each statement runs ${batches.toLocaleString("en-US")} ${batches === 1 ? "time" : "times"}, once for each batch of up to ${IMPORT_BATCH_ROWS} rows, and sees only that batch.`;
  return warnings.map((w) =>
    w.code === "triggers" ? { ...w, message: `${w.message} ${how}` } : w,
  );
}

const leftOutWords = (skipped: number, total: number, deleting = false): string =>
  skipped === 0
    ? ""
    : deleting
      ? ` ${skipped} of the ${total} rows ${skipped === 1 ? "is" : "are"} gone, so ${skipped === 1 ? "it is" : "they are"} left out (a delete is found by its key and does not compare values).`
      : ` ${skipped} of the ${total} rows changed since you loaded them (or are gone), so ${skipped === 1 ? "it is" : "they are"} left out.`;

async function planUpdateRows(db: Queryable, change: UpdateRowsChange): Promise<PlannedChange> {
  const { table, key } = await requireEditable(db, change.table);
  const set = change.set.map((s): TypedValue => {
    const column = findColumn(table, s.column);
    requireWritable(column);
    return { column: column.name, castType: column.castType, value: s.value };
  });
  if (set.length === 0 || change.rows.length === 0) throw invalidChange("Nothing to change.");
  if (change.rows.length > MAX_BULK_ROWS) throw invalidChange("Too many rows for one change.");
  await checkValues(db, set, (name) => findColumn(table, name).dataType);
  const keys = change.rows.map((r) => typedKey(table, key, r.key));
  distinctRows(keys);
  const names = set.map((s) => s.column);
  const { kept, skipped } = await splitByCurrent(
    db,
    change.table,
    change.rows.map((r, i) => ({ key: keys[i]!, expected: r.expected })),
  );
  if (kept.length === 0) throw new DatabaseError("row_changed");
  const warnings = await bulkWarnings(db, change.table, table, TRIGGER_EVENT.update, kept.length);
  const referenced = referencedWarning(
    await listIncomingForeignKeys(db, table.oid),
    "update",
    names,
  );
  if (referenced) warnings.push(referenced);
  return {
    change,
    statements: kept.map((i) =>
      buildUpdateRow(change.table, keys[i]!, set, change.rows[i]!.expected),
    ),
    expect: "one_row",
    category: "row",
    effect: `Sets ${listWords(names)} on ${kept.length} ${kept.length === 1 ? "row" : "rows"} of ${displayName(change.table.schema, change.table.name)}, each found by its key, if it still holds the value${names.length === 1 ? "" : "s"} you saw. All of them are changed or none is.${leftOutWords(skipped.length, change.rows.length)}`,
    warnings,
    destructive: false,
    guard: { relations: [guardRelation(table, [...key, ...names], "row_exclusive")] },
    skipped,
  };
}

async function planDeleteRows(db: Queryable, change: DeleteRowsChange): Promise<PlannedChange> {
  const { table, key } = await requireEditable(db, change.table);
  if (change.rows.length === 0) throw invalidChange("Nothing to remove.");
  if (change.rows.length > MAX_BULK_ROWS) throw invalidChange("Too many rows for one change.");
  const keys = change.rows.map((r) => typedKey(table, key, r.key));
  distinctRows(keys);
  const { kept, skipped } = await splitByCurrent(
    db,
    change.table,
    keys.map((k) => ({ key: k, expected: [] })),
  );
  if (kept.length === 0) throw new DatabaseError("row_changed");
  const warnings = await bulkWarnings(db, change.table, table, TRIGGER_EVENT.delete, kept.length);
  const referenced = referencedWarning(
    await listIncomingForeignKeys(db, table.oid),
    "delete",
    null,
  );
  const chain = await listCascadeChain(db, table.oid);
  if (referenced && chain.length > 0) {
    referenced.message += ` The cascade goes further down: rows of ${listWords(chain)} can be deleted too.`;
  } else if (chain.length > 0) {
    warnings.push({
      code: "referenced",
      message: `The cascade goes further down: rows of ${listWords(chain)} can be deleted too.`,
    });
  }
  if (referenced) warnings.push(referenced);
  warnings.push({ code: "destructive", message: "Deleted rows cannot be brought back." });
  return {
    change,
    statements: kept.map((i) => buildDeleteRow(change.table, keys[i]!)),
    expect: "one_row",
    category: "row",
    effect: `Deletes ${kept.length} ${kept.length === 1 ? "row" : "rows"} of ${displayName(change.table.schema, change.table.name)}, each found by its key. All of them are deleted or none is.${leftOutWords(skipped.length, change.rows.length, true)}`,
    warnings,
    destructive: true,
    guard: { relations: [guardRelation(table, key, "row_exclusive")] },
    skipped,
  };
}

// ------------------------------------------------------------------ import ---

/**
 * One batch of an import, in one statement:
 *
 *   INSERT INTO "s"."t" ("a", "b")
 *   SELECT CAST(x.c0 AS <type of a, without modifier>), CAST(x.c1 AS <type of b>)
 *   FROM unnest($1::text[], $2::text[]) AS x(c0, c1)
 *
 * The values of a column travel as ONE bound array; the names are quoted catalog names and the types come from
 * the catalog. The value is cast to the type WITHOUT its modifier, so that the assignment to the column (not the
 * cast) enforces a length or a domain's rule and refuses instead of cutting, as for one row.
 */
export function buildInsertBatch(
  table: TableRef,
  columns: ReadonlyArray<{ column: string; castType: string }>,
  rows: ReadonlyArray<ReadonlyArray<string | null>>,
): PlannedStatement {
  const names = columns.map((c) => quoteIdentifier(c.column)).join(", ");
  const casts = columns.map((c, i) => `CAST(x.c${i} AS ${c.castType})`).join(", ");
  const arrays = columns.map((_, i) => `$${i + 1}::text[]`).join(", ");
  const aliases = columns.map((_, i) => `c${i}`).join(", ");
  return {
    text:
      `INSERT INTO ${quoteQualified(table.schema, table.name)} (${names}) ` +
      `SELECT ${casts} FROM unnest(${arrays}) AS x(${aliases})`,
    values: columns.map((_, i) => rows.map((r) => r[i] ?? null)),
    expectRows: rows.length,
  };
}

async function planInsertRows(db: Queryable, change: InsertRowsChange): Promise<PlannedChange> {
  const { table } = await requireEditable(db, change.table);
  if (change.columns.length === 0 || change.rows.length === 0)
    throw invalidChange("Nothing to add.");
  if (change.columns.length > IMPORT_MAX_COLUMNS || change.rows.length > IMPORT_MAX_ROWS) {
    throw invalidChange("Too many rows or columns for one import.");
  }
  if (new Set(change.columns).size !== change.columns.length) {
    throw invalidChange("A column is listed twice.");
  }
  if (change.rows.some((r) => r.length !== change.columns.length)) {
    throw invalidChange("Every row needs one value for each column.");
  }
  const columns = change.columns.map((name) => {
    const column = findColumn(table, name);
    requireWritable(column);
    return { column: column.name, castType: column.castType };
  });
  const statements: PlannedStatement[] = [];
  for (let at = 0; at < change.rows.length; at += IMPORT_BATCH_ROWS) {
    statements.push(
      buildInsertBatch(change.table, columns, change.rows.slice(at, at + IMPORT_BATCH_ROWS)),
    );
  }
  const total = change.rows.length;
  // A value given for an identity column does not move its sequence: the next row added without one may collide.
  const given = change.columns.filter((name) => findColumn(table, name).identity !== null);
  const warnings = await bulkWarnings(
    db,
    change.table,
    table,
    TRIGGER_EVENT.insert,
    total,
    statements.length,
  );
  if (given.length > 0) {
    warnings.push({
      code: "may_fail",
      message: `${listWords(given)} ${given.length === 1 ? "is an identity column" : "are identity columns"}: values given here do not move ${given.length === 1 ? "its" : "their"} sequence, so a row added later without one can get a value that is already taken.`,
    });
  }
  const checked = (await listConstraints(db, table.oid)).filter((c) => c.type === "f").length;
  if (checked > 0) {
    warnings.push({
      code: "scan",
      message: `${checked === 1 ? "A foreign key" : `${checked} foreign keys`} of this table will be checked for each of the ${total.toLocaleString("en-US")} rows.`,
    });
  }
  return {
    change,
    statements,
    expect: "any",
    category: "row",
    effect: `Adds ${total.toLocaleString("en-US")} ${total === 1 ? "row" : "rows"} to ${displayName(change.table.schema, change.table.name)} in ${statements.length} ${statements.length === 1 ? "batch" : "batches"}, all in one transaction: every row is added or none is.${omittedWords(
      table,
      columns.map((c) => ({ ...c, value: null })),
    )}`,
    warnings,
    destructive: false,
    guard: {
      relations: [guardRelation(table, change.columns, "row_exclusive")],
    },
  };
}

export function planRowChange(db: Queryable, change: RowChange): Promise<PlannedChange> {
  switch (change.kind) {
    case "insert_rows":
      return planInsertRows(db, change);
    case "update_rows":
      return planUpdateRows(db, change);
    case "delete_rows":
      return planDeleteRows(db, change);
    case "update_row":
      return planUpdate(db, change);
    case "insert_row":
      return planInsert(db, change);
    case "delete_row":
      return planDelete(db, change);
    default:
      return Promise.reject(invalidChange("This kind of change is not offered."));
  }
}
