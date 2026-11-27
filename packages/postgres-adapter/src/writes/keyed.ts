/**
 * Imports by key (`docs/write-side-v2-plan.md`, 4.1, 4.2 and 13): update or insert (`upsert_rows`) and update only
 * (`update_by_key`). Each is batches of ONE fixed statement, built here from catalog names (quoted) and catalog
 * types, with every value of a column bound as one array:
 *
 *   INSERT INTO "s"."t" AS dc_t ("k", "a") SELECT CAST(x.c0 AS <type>), CAST(x.c1 AS <type>)
 *   FROM unnest($1::text[], $2::text[]) AS x(c0, c1)
 *   ON CONFLICT ("k") DO UPDATE SET "a" = EXCLUDED."a"            -- or DO NOTHING
 *   RETURNING (dc_t.xmax = 0) AS inserted                          -- only where PostgreSQL can say it (13.1, 7)
 *
 *   UPDATE "s"."t" AS dc_t SET "a" = CAST(x.c1 AS <type>)
 *   FROM unnest($1::text[], $2::text[]) AS x(c0, c1) WHERE dc_t."k" = CAST(x.c0 AS <type>)
 *
 * The key is re-derived at preview from the catalog: it must be exactly the columns of the table's primary key or
 * of one of its unique constraints that is not partial, not on expressions, not deferrable, with every column NOT
 * NULL; a request cannot name anything else. Two rows of the file with the same key are refused at preview over
 * the whole file (a repeated key would change a row twice, or make a batch short). The preview reads, in its
 * read-only transaction, which rows of the file find a row (one join of the file's keys against the table per
 * batch, the keys bound as arrays, only positions coming back), and every batch is planned for exactly the rows it
 * must report: anything else rolls the whole change back. No value is ever put in a statement's text, an error,
 * the preview or the history.
 */
import {
  DatabaseError,
  IMPORT_BATCH_ROWS,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
  MAX_CHANGE_PARTS,
  isSensitiveColumnName,
  quoteIdentifier,
  quoteQualified,
  type ChangeWarning,
  type PlannedChange,
  type PlannedStatement,
  type RowCounts,
  type TableRef,
  type UpdateByKeyChange,
  type UpsertRowsChange,
} from "@datacanvas/database-core";
import type { Queryable } from "../introspection/types.js";
import {
  TRIGGER_EVENT,
  canSelectTable,
  listConstraints,
  listIncomingForeignKeys,
  listTriggers,
  listUniqueColumns,
  listUniqueKeys,
  type CatalogTable,
} from "./catalog.js";
import { guardRelation } from "./guard.js";
import {
  bulkWarnings,
  findColumn,
  omittedWords,
  referencedWarning,
  requireEditable,
  requireNoChildren,
  requireWritable,
} from "./rows.js";
import { displayName, invalidChange, listWords } from "./sql.js";

/** A column of the request, with the type its values are cast to (the catalog's, without a modifier). */
export interface KeyedColumn {
  column: string;
  castType: string;
  /** The column's own collation, quoted, when it is not its type's default (see `CatalogColumn.collation`). */
  collation?: string;
}

// --------------------------------------------------------------- builders ---

const arrays = (count: number): string =>
  Array.from({ length: count }, (_, i) => `$${i + 1}::text[]`).join(", ");
const aliases = (count: number): string =>
  Array.from({ length: count }, (_, i) => `c${i}`).join(", ");
const valuesOf = (
  count: number,
  rows: ReadonlyArray<ReadonlyArray<string | null>>,
): Array<Array<string | null>> =>
  Array.from({ length: count }, (_, i) => rows.map((r) => r[i] ?? null));

/**
 * One batch of an upsert: the import batch with a conflict clause on the key's columns (catalog names), and
 * `DO UPDATE SET "c" = EXCLUDED."c"` for each column to update, or `DO NOTHING` when there is none. With
 * `countsInserted` it returns one boolean per row written, `inserted`, and nothing else. The target is given an
 * alias, so a table called `excluded` or `x` is just a name.
 */
export function buildUpsertBatch(
  table: TableRef,
  columns: readonly KeyedColumn[],
  key: readonly string[],
  update: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | null>>,
  plan: { expectRows: number; countsInserted: boolean },
): PlannedStatement {
  const names = columns.map((c) => quoteIdentifier(c.column)).join(", ");
  const casts = columns.map((c, i) => `CAST(x.c${i} AS ${c.castType})`).join(", ");
  const target = key.map((k) => quoteIdentifier(k)).join(", ");
  const action =
    update.length === 0
      ? "DO NOTHING"
      : `DO UPDATE SET ${update.map((u) => `${quoteIdentifier(u)} = EXCLUDED.${quoteIdentifier(u)}`).join(", ")}`;
  return {
    text:
      `INSERT INTO ${quoteQualified(table.schema, table.name)} AS dc_t (${names}) ` +
      `SELECT ${casts} FROM unnest(${arrays(columns.length)}) AS x(${aliases(columns.length)}) ` +
      `ON CONFLICT (${target}) ${action}` +
      (plan.countsInserted ? " RETURNING (dc_t.xmax = 0) AS inserted" : ""),
    values: valuesOf(columns.length, rows),
    expectRows: plan.expectRows,
    ...(plan.countsInserted ? { countsInserted: true } : {}),
  };
}

/** A column set to the SAME value on every row of a batch: the value is bound once, after the arrays. */
export interface SameValue extends KeyedColumn {
  value: string | null;
}

/**
 * One batch of an update by key: each row of the batch sets the columns that are not the key on the row its key
 * finds. The target and the rows have aliases, and every column of the target in the condition is qualified, so
 * a column called `c0` or `x` is just a name. It reports the rows of the table it touched: every key carried
 * finds one row, or the batch is short.
 *
 * `same` (a change of the rows a filter matches, section 6) are columns set to one value on every row: each is ONE
 * bound parameter, `"c" = CAST($n AS <type>)`, never an array of the same value 500 times.
 */
export function buildUpdateByKeyBatch(
  table: TableRef,
  columns: readonly KeyedColumn[],
  key: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | null>>,
  same: readonly SameValue[] = [],
): PlannedStatement {
  const at = (name: string): number => columns.findIndex((c) => c.column === name);
  const set = [
    ...columns
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !key.includes(c.column))
      .map(({ c, i }) => `${quoteIdentifier(c.column)} = CAST(x.c${i} AS ${c.castType})`),
    ...same.map(
      (s, j) => `${quoteIdentifier(s.column)} = CAST($${columns.length + j + 1} AS ${s.castType})`,
    ),
  ].join(", ");
  const where = key
    .map((k) => `dc_t.${quoteIdentifier(k)} = CAST(x.c${at(k)} AS ${columns[at(k)]!.castType})`)
    .join(" AND ");
  return {
    text:
      `UPDATE ${quoteQualified(table.schema, table.name)} AS dc_t SET ${set} ` +
      `FROM unnest(${arrays(columns.length)}) AS x(${aliases(columns.length)}) WHERE ${where}`,
    values: [...valuesOf(columns.length, rows), ...same.map((s) => s.value)],
    expectRows: rows.length,
  };
}

/**
 * One batch of a keyed delete (a change of the rows a filter matches, section 6 and 13.2): each key of the batch
 * deletes the row it finds. As the update by key, the target and the keys have aliases and every column of the
 * target is qualified. It reports the rows it deleted: every key carried finds one row, or the batch is short.
 */
export function buildDeleteByKeyBatch(
  table: TableRef,
  key: readonly KeyedColumn[],
  rows: ReadonlyArray<ReadonlyArray<string | null>>,
): PlannedStatement {
  const where = key
    .map((k, i) => `dc_t.${quoteIdentifier(k.column)} = CAST(x.c${i} AS ${k.castType})`)
    .join(" AND ");
  return {
    text:
      `DELETE FROM ${quoteQualified(table.schema, table.name)} AS dc_t ` +
      `USING unnest(${arrays(key.length)}) AS x(${aliases(key.length)}) WHERE ${where}`,
    values: valuesOf(key.length, rows),
    expectRows: rows.length,
  };
}

/**
 * Which rows of a batch of the file find a row of the table by the key (a read, at preview, in the read-only
 * transaction): the keys and the rows' positions travel as bound arrays, and only positions come back.
 */
export function buildFindExisting(
  table: TableRef,
  key: readonly KeyedColumn[],
  rows: ReadonlyArray<{ position: number; key: ReadonlyArray<string | null> }>,
): PlannedStatement {
  const where = key
    .map((k, i) => `dc_t.${quoteIdentifier(k.column)} = CAST(x.c${i} AS ${k.castType})`)
    .join(" AND ");
  return {
    text:
      `SELECT x.n FROM unnest(${arrays(key.length)}, $${key.length + 1}::int4[]) AS x(${aliases(key.length)}, n) ` +
      `WHERE EXISTS (SELECT 1 FROM ${quoteQualified(table.schema, table.name)} AS dc_t WHERE ${where})`,
    values: [
      ...valuesOf(
        key.length,
        rows.map((r) => r.key),
      ),
      rows.map((r) => String(r.position)),
    ],
  };
}

/**
 * Rows of the file that have the same key, compared as the database compares them (`'1'` and `'01'` are one
 * integer, and two strings a nondeterministic collation of the column calls equal are one key: the column's own
 * collation, from the catalog, is applied): the positions of the first few groups, and nothing else. Over the whole
 * file at once.
 */
export function buildFindRepeatedKeys(
  key: readonly KeyedColumn[],
  rows: ReadonlyArray<ReadonlyArray<string | null>>,
): PlannedStatement {
  const groups = key
    .map((k, i) => `CAST(x.c${i} AS ${k.castType})${k.collation ? ` COLLATE ${k.collation}` : ""}`)
    .join(", ");
  return {
    text:
      `SELECT (array_agg(x.n ORDER BY x.n))[1:5] AS positions ` +
      `FROM unnest(${arrays(key.length)}, $${key.length + 1}::int4[]) AS x(${aliases(key.length)}, n) ` +
      `GROUP BY ${groups} HAVING count(*) > 1 ORDER BY min(x.n) LIMIT 10`,
    values: [...valuesOf(key.length, rows), rows.map((_, i) => String(i + 1))],
  };
}

// --------------------------------------------------------------- planning ---

interface KeyedImport {
  table: CatalogTable;
  /** The key's columns as the catalog names them, in the constraint's order. */
  key: string[];
  keyName: string;
  /** The request's columns with their cast types, in the request's order. */
  columns: KeyedColumn[];
  /** The key's values of each row, in the key's order. */
  keyRows: Array<Array<string | null>>;
}

/** Row numbers for a person: 1-based, the first few. */
const rowNumbers = (numbers: readonly number[]): string =>
  `${numbers.length === 1 ? "row" : "rows"} ${listWords(numbers.map((n) => n.toLocaleString("en-US")))}`;
const many = (n: number, one: string, more = `${one}s`): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : more}`;

/** The SQLSTATE of a failure, if it has one. */
const sqlState = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

/**
 * The checks both imports by key make before anything is planned: the table can be edited, the request fits the
 * limits, the key is one the table has and may be used, every key column is mapped, and no row lacks a key value.
 */
async function resolveKeyedImport(
  db: Queryable,
  change: UpsertRowsChange | UpdateByKeyChange,
  writable: (name: string, inKey: boolean) => boolean,
): Promise<KeyedImport> {
  const { table } = await requireEditable(db, change.table);
  await requireNoChildren(db, table);
  if (change.columns.length === 0 || change.rows.length === 0)
    throw invalidChange("Nothing to import.");
  if (change.columns.length > IMPORT_MAX_COLUMNS || change.rows.length > IMPORT_MAX_ROWS) {
    throw invalidChange("Too many rows or columns for one import.");
  }
  if (new Set(change.columns).size !== change.columns.length) {
    throw invalidChange("A column is listed twice.");
  }
  if (change.rows.some((r) => r.length !== change.columns.length)) {
    throw invalidChange("Every row needs one value for each column.");
  }
  if (
    change.key.length === 0 ||
    change.key.length > MAX_CHANGE_PARTS ||
    new Set(change.key).size !== change.key.length
  ) {
    throw invalidChange("The key must name each of its columns once.");
  }
  // A key that finds rows by a value must not be a way to ask whether a hidden value exists: the preview says which
  // rows of the file find a row, and edit_cells and a page of rows refuse a hidden key column for the same reason.
  const hiddenKey = change.key.filter((name) => isSensitiveColumnName(name));
  if (hiddenKey.length > 0) {
    throw invalidChange(
      `${listWords(hiddenKey)} ${hiddenKey.length === 1 ? "is a column" : "are columns"} whose name looks sensitive, and ${hiddenKey.length === 1 ? "its values are" : "their values are"} hidden: such a key cannot be used to import by key.`,
    );
  }
  const columns = change.columns.map((name): KeyedColumn => {
    const column = findColumn(table, name);
    if (writable(name, change.key.includes(name))) requireWritable(column);
    return {
      column: column.name,
      castType: column.castType,
      ...(column.collation
        ? { collation: quoteQualified(column.collation.schema, column.collation.name) }
        : {}),
    };
  });

  // The key is re-derived from the catalog: exactly the columns of one of the table's own keys, and one it may use.
  const same = (await listUniqueKeys(db, table.oid)).filter(
    (k) => k.columns.length === change.key.length && k.columns.every((c) => change.key.includes(c)),
  );
  const chosen = same.find((k) => k.eligible);
  if (!chosen) {
    throw invalidChange(
      same.length === 0
        ? `${listWords(change.key)} ${change.key.length === 1 ? "is" : "are"} not the primary key or a unique constraint of this table. An import by key needs one of them.`
        : `The key ${same[0]!.name} cannot be used: an import by key needs a primary key or unique constraint that is not deferrable and whose columns are all NOT NULL.`,
    );
  }
  const missing = chosen.columns.filter((k) => !change.columns.includes(k));
  if (missing.length > 0) {
    throw invalidChange(`Every column of the key must be mapped: ${listWords(missing)} is not.`);
  }
  const positions = chosen.columns.map((k) => change.columns.indexOf(k));
  const keyRows = change.rows.map((r) => positions.map((p) => r[p] ?? null));
  // A key column is NOT NULL: a row without a value there could never find a row, nor be added.
  const empty: number[] = [];
  for (let i = 0; i < keyRows.length && empty.length < 5; i++) {
    if (keyRows[i]!.some((v) => v === null)) empty.push(i + 1);
  }
  if (empty.length > 0) {
    throw invalidChange(
      `The file has no value for the key (${listWords(chosen.columns)}) in ${rowNumbers(empty)}. Every row needs its key.`,
    );
  }
  return { table, key: chosen.columns, keyName: chosen.name, columns, keyRows };
}

/**
 * Refuse a file in which two rows have the same key, over the whole file (a repeated key in one batch is an error
 * or a short batch, and across two batches it would change a row twice: 13.1, item 8, and 13.2, item 2), then find
 * the rows of the file that already have a row in the table. Both are reads in the preview's read-only
 * transaction, in one savepoint: a key value that does not fit its type ends them with a fixed message.
 */
async function readKeys(
  db: Queryable,
  ref: TableRef,
  plan: KeyedImport,
): Promise<{ existing: Set<number> }> {
  const key = plan.key.map((name) => plan.columns.find((c) => c.column === name)!);
  const existing = new Set<number>();
  let repeated: number[][] = [];
  await db.query("SAVEPOINT dc_keyed_check");
  try {
    const twice = buildFindRepeatedKeys(key, plan.keyRows);
    const groups = await db.query<{ positions: unknown[] }>(twice.text, twice.values);
    repeated = groups.rows.map((g) => g.positions.map(Number));
    if (repeated.length === 0) {
      for (let at = 0; at < plan.keyRows.length; at += IMPORT_BATCH_ROWS) {
        const batch = plan.keyRows
          .slice(at, at + IMPORT_BATCH_ROWS)
          .map((k, i) => ({ position: at + i, key: k }));
        const find = buildFindExisting(ref, key, batch);
        const found = await db.query<{ n: unknown }>(find.text, find.values);
        for (const row of found.rows) existing.add(Number(row.n));
      }
    }
    await db.query("RELEASE SAVEPOINT dc_keyed_check");
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT dc_keyed_check");
    const code = sqlState(error);
    if (typeof code === "string" && code.startsWith("22")) {
      throw new DatabaseError("invalid_value", {
        message: `A value of the key (${listWords(plan.key)}) is not valid for the type of its column.`,
        cause: error,
      });
    }
    throw error;
  }
  if (repeated.length > 0) {
    throw invalidChange(
      `Some rows of the file have the same key (${listWords(plan.key)}): ${repeated.map((g) => rowNumbers(g)).join("; ")}. Each row must have its own key.`,
    );
  }
  return { existing };
}

/** The warnings every import gives about the rows it adds: identity values and foreign keys (as `insert_rows`). */
async function addedRowsWarnings(
  db: Queryable,
  table: CatalogTable,
  columns: readonly string[],
  rows: number,
): Promise<ChangeWarning[]> {
  const warnings: ChangeWarning[] = [];
  const given = columns.filter((name) => findColumn(table, name).identity !== null);
  if (given.length > 0) {
    warnings.push({
      code: "may_fail",
      message: `${listWords(given)} ${given.length === 1 ? "is an identity column" : "are identity columns"}: values given here do not move ${given.length === 1 ? "its" : "their"} sequence, so a row added later without one can get a value that is already taken.`,
    });
  }
  const checked = (await listConstraints(db, table.oid)).filter((c) => c.type === "f").length;
  if (checked > 0 && rows > 0) {
    warnings.push({
      code: "scan",
      message: `${checked === 1 ? "A foreign key" : `${checked} foreign keys`} of this table will be checked for each of the ${rows.toLocaleString("en-US")} rows.`,
    });
  }
  return warnings;
}

export async function planUpsertRows(
  db: Queryable,
  change: UpsertRowsChange,
): Promise<PlannedChange> {
  const plan = await resolveKeyedImport(db, change, () => true);
  const { table } = plan;
  const update = change.updateColumns;
  if (new Set(update).size !== update.length) {
    throw invalidChange("A column to update is listed twice.");
  }
  for (const name of update) {
    if (!change.columns.includes(name)) {
      throw invalidChange(`${name} is not a mapped column, so it cannot be updated.`);
    }
    if (plan.key.includes(name)) {
      throw invalidChange(`${name} is part of the key: the key finds the row, it is not updated.`);
    }
  }
  // A column of another unique key (or of the primary key) is never updated: a row would conflict on a key that is
  // not the one chosen (an error, not an update) or move under a foreign key (13.1, item 4).
  const unique = await listUniqueColumns(db, table.oid);
  const keyed = update.filter((name) => unique.includes(name));
  if (keyed.length > 0) {
    throw invalidChange(
      `${listWords(keyed)} ${keyed.length === 1 ? "is part of a unique key or of the primary key" : "are part of unique keys or of the primary key"} of this table, so an update or insert cannot update ${keyed.length === 1 ? "it" : "them"}. Leave ${keyed.length === 1 ? "it" : "them"} out of the columns to update.`,
    );
  }

  const { existing } = await readKeys(db, change.table, plan);
  const total = change.rows.length;
  const found = existing.size;
  const added = total - found;
  const doUpdate = update.length > 0;
  // `xmax` says row by row whether a row was inserted, but not on a partitioned table, and only to a role that may
  // read the table (13.1, item 7). Elsewhere the result gives the preview's split as the estimate it is.
  const countsInserted = doUpdate && table.relkind === "r" && (await canSelectTable(db, table.oid));
  const statements: PlannedStatement[] = [];
  for (let at = 0; at < total; at += IMPORT_BATCH_ROWS) {
    const rows = change.rows.slice(at, at + IMPORT_BATCH_ROWS);
    let foundHere = 0;
    for (let i = at; i < at + rows.length; i++) if (existing.has(i)) foundHere += 1;
    // DO UPDATE reports every row it inserted or updated; DO NOTHING only the rows that were new.
    statements.push(
      buildUpsertBatch(change.table, plan.columns, plan.key, update, rows, {
        expectRows: doUpdate ? rows.length : rows.length - foundHere,
        countsInserted,
      }),
    );
  }
  const counts: RowCounts = {
    insert: added,
    update: doUpdate ? found : 0,
    unchanged: doUpdate ? 0 : found,
  };

  const events = TRIGGER_EVENT.insert | (doUpdate ? TRIGGER_EVENT.update : 0);
  const warnings = await bulkWarnings(db, change.table, table, events, total, statements.length);
  if (found > 0 && (await listTriggers(db, table.oid, TRIGGER_EVENT.insert)).length > 0) {
    // 13.1, item 9: a BEFORE INSERT row trigger runs for every row, the ones that turn into updates included.
    const sentence = doUpdate
      ? ` Triggers that run before each inserted row run for all ${total.toLocaleString("en-US")} rows, the ${many(found, "row")} that become updates included; update triggers run for those ${many(found, "row")}, and triggers that run after each inserted row only for the ${many(added, "new row")}.`
      : ` Triggers that run before each inserted row run for all ${total.toLocaleString("en-US")} rows, the ${many(found, "row")} that already exist and are left as they are included; triggers that run after each inserted row run only for the ${many(added, "new row")}.`;
    for (const w of warnings) if (w.code === "triggers") w.message += sentence;
  }
  warnings.push(...(await addedRowsWarnings(db, table, change.columns, added)));
  if (doUpdate && found > 0) {
    warnings.push({
      code: "destructive",
      message: `${many(found, "row")} will be overwritten: the values ${found === 1 ? "it holds" : "they hold"} now in ${listWords(update)} cannot be brought back.`,
    });
  }

  const name = displayName(change.table.schema, change.table.name);
  const by = `by ${plan.keyName} (${listWords(plan.key)})`;
  const first = doUpdate
    ? `Adds ${many(added, "new row")} to ${name} and updates ${many(found, "row")} that already ${found === 1 ? "exists" : "exist"} ${by}: ${many(found, "row")} will be overwritten in ${listWords(update)}.`
    : `Adds ${many(added, "new row")} to ${name} and leaves the ${many(found, "row")} that already ${found === 1 ? "exists" : "exist"} ${by} as ${found === 1 ? "it is" : "they are"}.`;
  const estimate =
    doUpdate && !countsInserted
      ? " PostgreSQL cannot say row by row which rows it inserted and which it updated here (a partitioned table, or a role that may not read the table): the result gives this preview's count as an estimate."
      : "";
  return {
    change,
    statements,
    expect: "any",
    category: "row",
    effect: `${first} ${many(total, "row")} in ${many(statements.length, "batch", "batches")}, all in one transaction: every row is written or none is.${estimate}${omittedWords(
      table,
      plan.columns.map((c) => ({ ...c, value: null })),
    )}`,
    warnings,
    destructive: doUpdate && found > 0,
    guard: { relations: [guardRelation(table, change.columns, "row_exclusive")] },
    counts,
  };
}

export async function planUpdateByKey(
  db: Queryable,
  change: UpdateByKeyChange,
): Promise<PlannedChange> {
  // The key only finds the row: it may be a column the database fills. Every other column is written.
  const plan = await resolveKeyedImport(db, change, (_, inKey) => !inKey);
  const { table } = plan;
  const set = change.columns.filter((name) => !plan.key.includes(name));
  if (set.length === 0) throw invalidChange("Nothing to change: every mapped column is the key.");

  const { existing } = await readKeys(db, change.table, plan);
  const kept: number[] = [];
  const skipped: number[] = [];
  for (let i = 0; i < change.rows.length; i++) (existing.has(i) ? kept : skipped).push(i);
  if (kept.length === 0) {
    throw new DatabaseError("row_changed", {
      message: "No row of the file finds a row of the table by its key, so nothing would change.",
    });
  }
  const statements: PlannedStatement[] = [];
  for (let at = 0; at < kept.length; at += IMPORT_BATCH_ROWS) {
    statements.push(
      buildUpdateByKeyBatch(
        change.table,
        plan.columns,
        plan.key,
        kept.slice(at, at + IMPORT_BATCH_ROWS).map((i) => change.rows[i]!),
      ),
    );
  }
  const warnings = await bulkWarnings(
    db,
    change.table,
    table,
    TRIGGER_EVENT.update,
    kept.length,
    statements.length,
  );
  const referenced = referencedWarning(await listIncomingForeignKeys(db, table.oid), "update", set);
  if (referenced) warnings.push(referenced);
  warnings.push({
    code: "destructive",
    message: `${many(kept.length, "row")} will be overwritten: the values ${kept.length === 1 ? "it holds" : "they hold"} now in ${listWords(set)} cannot be brought back. Rows are found by their key when you apply; their values are not compared.`,
  });
  const name = displayName(change.table.schema, change.table.name);
  const left =
    skipped.length === 0
      ? ""
      : ` ${many(skipped.length, "row")} of the file ${skipped.length === 1 ? "finds" : "find"} no row by ${plan.keyName} and ${skipped.length === 1 ? "is" : "are"} left out.`;
  return {
    change,
    statements,
    expect: "any",
    category: "row",
    effect: `Updates ${many(kept.length, "row")} of ${name}, each found by ${plan.keyName} (${listWords(plan.key)}): sets ${listWords(set)}. ${many(statements.length, "batch", "batches")}, all in one transaction: every row is updated or none is.${left}`,
    warnings,
    destructive: true,
    guard: { relations: [guardRelation(table, change.columns, "row_exclusive")] },
    skipped,
    counts: { insert: 0, update: kept.length, unchanged: 0 },
  };
}
