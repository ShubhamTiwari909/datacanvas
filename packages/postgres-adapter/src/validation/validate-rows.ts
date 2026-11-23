/**
 * Validation: would the database accept these values? Answered in a TEMPORARY copy of the table, never in
 * the table itself (`docs/advanced-data-workspace-plan.md`, section 6.2; decisions 154 and 157).
 *
 * What the facts of the D0 spike (`postgres.adapter.validation-spike.test.ts`) settled, and this file does:
 *
 *  - The copy is `CREATE TEMP TABLE ... (LIKE target INCLUDING CONSTRAINTS INCLUDING GENERATED)`: the
 *    column types (so a domain's check applies), NOT NULL, CHECK and generated columns, and NO triggers,
 *    NO foreign keys, NO defaults (a copied default that calls a sequence would advance the real
 *    sequence, which a rollback does not undo) and NO indexes (a key the database would fill itself
 *    must not be demanded). The NOT NULL of a column the database would fill itself (a default, an
 *    identity) is dropped in the copy unless the row gives that column a value.
 *  - Uniqueness and foreign keys are asked by read-only queries on the real tables.
 *  - Failing rows are found by halving the batch (savepoints), and the failing column of a value that
 *    does not cast by trying the row's cells one at a time. A message of the database is never read:
 *    it can hold a value. Only the SQLSTATE, the column and the constraint name are used.
 *
 * The transaction (`withCheckingTransaction`) switches itself to read-only before any value goes in and is
 * always rolled back. Nothing here returns, logs or keeps a value: the report holds rules, names, counts
 * and row numbers.
 */
import type { Pool } from "pg";
import {
  DatabaseError,
  IssueCollector,
  VALIDATE_MAX_FAILURES_FOUND,
  VALIDATE_ROWS_LISTED,
  buildReport,
  checkValidateRequest,
  isSensitiveColumnName,
  quoteIdentifier,
  quoteQualified,
  type ValidateRequest,
  type ValidationNote,
  type ValidationReport,
  type ValidationRule,
} from "@datacanvas/database-core";
import { withCheckingTransaction } from "../connection/checking-transaction.js";
import type { Queryable } from "../connection/read-only.js";
import { findRowKey, findRowSecurity } from "../introspection/rows.js";
import {
  TRIGGER_EVENT,
  listTriggers,
  loadTable,
  type CatalogColumn,
  type CatalogTable,
} from "../writes/catalog.js";

/** The temporary copy's name. It lives in the session's own temporary schema and is created fresh in a transaction that is rolled back. */
const COPY = "dc_validate";

// ----------------------------------------------------------- statements ---

interface TypedColumn {
  name: string;
  /** The column's type without its modifier (an assignment, not the cast, enforces a length or a domain). */
  castType: string;
}

/**
 * Rows into the copy, in one statement:
 *
 *   INSERT INTO "dc_validate" ("a", "b", "dc_row")
 *   SELECT CAST(x.c0 AS <type of a>), CAST(x.c1 AS <type of b>), x.rn
 *   FROM unnest($1::text[], $2::text[], $3::int[]) AS x(c0, c1, rn)
 *
 * The values travel as arrays of text (bound), the names are quoted catalog names, the types come from
 * the catalog.
 */
export function buildBatchInsert(
  rowColumn: string,
  columns: readonly TypedColumn[],
): { text: string } {
  const names = [...columns.map((c) => quoteIdentifier(c.name)), quoteIdentifier(rowColumn)];
  const casts = [...columns.map((c, i) => `CAST(x.c${i} AS ${c.castType})`), "x.rn"];
  const placeholders = [
    ...columns.map((_, i) => `$${i + 1}::text[]`),
    `$${columns.length + 1}::int[]`,
  ];
  const aliases = [...columns.map((_, i) => `c${i}`), "rn"];
  return {
    text:
      `INSERT INTO ${quoteIdentifier(COPY)} (${names.join(", ")}) ` +
      `SELECT ${casts.join(", ")} FROM unnest(${placeholders.join(", ")}) AS x(${aliases.join(", ")})`,
  };
}

/**
 * The one row an update would leave, into the copy: the row as it is, with the new values in the columns
 * being set.
 *
 *   INSERT INTO "dc_validate" ("a", "b", "dc_row")
 *   SELECT t."a", CAST($1 AS <type of b>), 1 FROM "s"."t" AS t WHERE t."k" = CAST($2 AS <type of k>)
 */
export function buildUpdateInsert(
  table: { schema: string; name: string },
  rowColumn: string,
  stored: readonly CatalogColumn[],
  set: ReadonlyMap<string, TypedColumn>,
  keyColumns: readonly TypedColumn[],
): { text: string; setOrder: string[] } {
  const setOrder: string[] = [];
  const select = stored.map((c) => {
    const given = set.get(c.name);
    if (!given) return `t.${quoteIdentifier(c.name)}`;
    setOrder.push(c.name);
    return `CAST($${setOrder.length} AS ${given.castType})`;
  });
  const where = keyColumns.map(
    (k, i) => `t.${quoteIdentifier(k.name)} = CAST($${setOrder.length + i + 1} AS ${k.castType})`,
  );
  return {
    setOrder,
    text:
      `INSERT INTO ${quoteIdentifier(COPY)} (${[...stored.map((c) => quoteIdentifier(c.name)), quoteIdentifier(rowColumn)].join(", ")}) ` +
      `SELECT ${[...select, "1"].join(", ")} FROM ${quoteQualified(table.schema, table.name)} AS t ` +
      `WHERE ${where.join(" AND ")}`,
  };
}

/** `"a" IS NOT NULL AND "b" IS NOT NULL` for columns of an alias. */
function allPresent(alias: string, columns: readonly string[]): string {
  return columns.map((c) => `${alias}.${quoteIdentifier(c)} IS NOT NULL`).join(" AND ");
}

/**
 * Rows of the copy that repeat a value of a unique key within the copy:
 * `count` and the first row numbers. Only rows with every key column given count (a NULL is never equal).
 */
export function buildDuplicatesQuery(rowColumn: string, columns: readonly string[]): string {
  const rowCol = quoteIdentifier(rowColumn);
  const parts = columns.map((c) => `c.${quoteIdentifier(c)}`).join(", ");
  return (
    `WITH dup AS (SELECT c.${rowCol} AS rn, count(*) OVER (PARTITION BY ${parts}) AS n ` +
    `FROM ${quoteIdentifier(COPY)} AS c WHERE ${allPresent("c", columns)}) ` +
    `SELECT count(*)::int AS n, COALESCE((array_agg(rn ORDER BY rn))[1:${VALIDATE_ROWS_LISTED}], '{}') AS rows ` +
    `FROM dup WHERE n > 1`
  );
}

/**
 * Rows of the copy whose value of a unique key is already held by a row of the real table (other than the
 * row being updated, whose key is `self`).
 */
export function buildExistingQuery(
  table: { schema: string; name: string },
  rowColumn: string,
  columns: readonly string[],
  self: readonly TypedColumn[] | null,
): string {
  const rowCol = quoteIdentifier(rowColumn);
  const same = columns
    .map((c) => `t.${quoteIdentifier(c)} = c.${quoteIdentifier(c)}`)
    .join(" AND ");
  // The row being updated is not a collision with itself.
  const notSelf = self
    ? ` AND NOT (${self.map((k, i) => `t.${quoteIdentifier(k.name)} = CAST($${i + 1} AS ${k.castType})`).join(" AND ")})`
    : "";
  return (
    `WITH hit AS (SELECT c.${rowCol} AS rn FROM ${quoteIdentifier(COPY)} AS c WHERE ${allPresent("c", columns)} ` +
    `AND EXISTS (SELECT 1 FROM ${quoteQualified(table.schema, table.name)} AS t WHERE ${same}${notSelf})) ` +
    `SELECT count(*)::int AS n, COALESCE((array_agg(rn ORDER BY rn))[1:${VALIDATE_ROWS_LISTED}], '{}') AS rows FROM hit`
  );
}

/** Rows of the copy that point at a row that is not there (MATCH SIMPLE, or MATCH FULL's rule for a partly empty key). */
export function buildOrphanQuery(
  rowColumn: string,
  ref: { schema: string; name: string },
  columns: readonly string[],
  refColumns: readonly string[],
  full: boolean,
): string {
  const rowCol = quoteIdentifier(rowColumn);
  const match = columns
    .map((c, i) => `r.${quoteIdentifier(refColumns[i]!)} = c.${quoteIdentifier(c)}`)
    .join(" AND ");
  const none = `NOT EXISTS (SELECT 1 FROM ${quoteQualified(ref.schema, ref.name)} AS r WHERE ${match})`;
  const anyGiven = columns.map((c) => `c.${quoteIdentifier(c)} IS NOT NULL`).join(" OR ");
  const anyEmpty = columns.map((c) => `c.${quoteIdentifier(c)} IS NULL`).join(" OR ");
  const broken = full
    ? `(${anyGiven}) AND ((${anyEmpty}) OR ${none})`
    : `${allPresent("c", columns)} AND ${none}`;
  return (
    `WITH bad AS (SELECT c.${rowCol} AS rn FROM ${quoteIdentifier(COPY)} AS c WHERE ${broken}) ` +
    `SELECT count(*)::int AS n, COALESCE((array_agg(rn ORDER BY rn))[1:${VALIDATE_ROWS_LISTED}], '{}') AS rows FROM bad`
  );
}

// ------------------------------------------------------------- catalog ---

interface UniqueKey {
  name: string;
  columns: string[];
  /** Partial, on an expression, or NULLS NOT DISTINCT: not checked, and the report says so. */
  complex: boolean;
}

const UNIQUE_SQL = `
  SELECT ic.relname::text AS name,
    ARRAY(
      SELECT a.attname::text
      FROM generate_series(0, ix.indnkeyatts - 1) AS g(pos)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ix.indkey[g.pos]
      ORDER BY g.pos
    ) AS columns,
    (ix.indpred IS NOT NULL OR ix.indexprs IS NOT NULL
      OR COALESCE((to_jsonb(ix) ->> 'indnullsnotdistinct')::boolean, false)) AS complex
  FROM pg_catalog.pg_index ix
  JOIN pg_catalog.pg_class ic ON ic.oid = ix.indexrelid
  WHERE ix.indrelid = $1::oid AND ix.indisunique AND ix.indisvalid AND ix.indislive
  ORDER BY ix.indisprimary DESC, ic.relname
`;

interface ForeignKey {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  full: boolean;
}

const FOREIGN_KEYS_SQL = `
  SELECT con.conname::text AS name, rn.nspname::text AS ref_schema, rc.relname::text AS ref_table,
    (con.confmatchtype = 'f') AS full,
    ARRAY(
      SELECT a.attname::text
      FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      ORDER BY k.ord
    ) AS columns,
    ARRAY(
      SELECT a.attname::text
      FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
      ORDER BY k.ord
    ) AS ref_columns
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
  JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
  WHERE con.contype = 'f' AND con.conrelid = $1::oid AND con.conparentid = 0
  ORDER BY con.conname
`;

/** What the copy cannot carry or see, from the catalog: one row of three yes-or-no answers. */
const LIMITS_SQL = `
  SELECT
    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = $1::oid AND contype = 'x') AS exclusion,
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = $1::oid AND contype = 'c' AND COALESCE(array_length(conkey, 1), 0) <> 1
    ) AS wide_check,
    EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled <> 'D') AS event_triggers
`;

interface Prepared {
  table: CatalogTable;
  /** The columns the request gives, in its order. */
  supplied: CatalogColumn[];
  /** The name of the copy's row-number column (not a name the table uses). */
  rowColumn: string;
  uniques: UniqueKey[];
  foreignKeys: ForeignKey[];
  notes: ValidationNote[];
  /** For an update: the table's row key, with the values of the row. */
  key: Array<TypedColumn & { value: string }> | null;
}

const bad = () => new DatabaseError("invalid_request");

async function prepare(db: Queryable, request: ValidateRequest): Promise<Prepared> {
  const table = await loadTable(db, request.table);
  if (!table) throw new DatabaseError("not_found");
  if (table.relkind === "f") throw new DatabaseError("not_supported");
  // Only a table can be written to: a view, a materialized view and the rest have nothing to check against.
  if (table.relkind !== "r" && table.relkind !== "p") throw new DatabaseError("not_supported");

  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const supplied = request.columns.map((name) => {
    const column = byName.get(name);
    // A generated column, and an identity that is always generated, cannot be given a value.
    if (!column || column.generated || column.identity === "always") throw bad();
    return column;
  });

  let key: Prepared["key"] = null;
  if (request.mode === "update") {
    const order = await findRowKey(db, request.table);
    const given = request.key ?? [];
    if (order.kind === "none" || given.length !== order.columns.length) throw bad();
    const values = new Map<string, string>();
    for (const part of given) {
      if (values.has(part.column) || !order.columns.includes(part.column)) throw bad();
      values.set(part.column, part.value);
    }
    key = order.columns.map((name) => ({
      name,
      castType: byName.get(name)!.castType,
      value: values.get(name)!,
    }));
  }

  const taken = new Set(table.columns.map((c) => c.name));
  let rowColumn = "dc_row";
  while (taken.has(rowColumn)) rowColumn += "_";

  // The copy. LIKE with INCLUDING CONSTRAINTS and GENERATED only: no defaults, no indexes, no identity,
  // no triggers, no foreign keys.
  await db.query(
    `CREATE TEMP TABLE ${quoteIdentifier(COPY)} (LIKE ${quoteQualified(table.schema, table.name)} INCLUDING CONSTRAINTS INCLUDING GENERATED)`,
  );
  await db.query(
    `ALTER TABLE ${quoteIdentifier(COPY)} ADD COLUMN ${quoteIdentifier(rowColumn)} integer`,
  );
  // A column the database fills itself is not asked for when the row does not give it.
  const givenNames = new Set(request.columns);
  const relaxed = table.columns.filter(
    (c) =>
      request.mode === "insert" &&
      c.notNull &&
      !c.generated &&
      (c.hasDefault || c.identity !== null) &&
      !givenNames.has(c.name),
  );
  if (relaxed.length > 0) {
    await db.query(
      `ALTER TABLE ${quoteIdentifier(COPY)} ${relaxed.map((c) => `ALTER COLUMN ${quoteIdentifier(c.name)} DROP NOT NULL`).join(", ")}`,
    );
  }

  const uniques = (await db.query<UniqueKey>(UNIQUE_SQL, [table.oid])).rows;
  const fks = (
    await db.query<{
      name: string;
      ref_schema: string;
      ref_table: string;
      full: boolean;
      columns: string[];
      ref_columns: string[];
    }>(FOREIGN_KEYS_SQL, [table.oid])
  ).rows;

  const notes: ValidationNote[] = [];
  const events = request.mode === "insert" ? TRIGGER_EVENT.insert : TRIGGER_EVENT.update;
  if ((await listTriggers(db, table.oid, events)).length > 0) notes.push("triggers");
  if ((await findRowSecurity(db, request.table)) === "applies") notes.push("row_level_security");
  const limits = (
    await db.query<{ exclusion: boolean; wide_check: boolean; event_triggers: boolean }>(
      LIMITS_SQL,
      [table.oid],
    )
  ).rows[0];
  if (limits?.exclusion) notes.push("exclusion_constraints");
  if (limits?.event_triggers) notes.push("event_triggers");
  if (table.relkind === "p" || table.isPartition) notes.push("partition_bounds");
  // The copy has no defaults: a CHECK across several columns meets NULL in a column that was not given.
  const unfilled = table.columns.some(
    (c) =>
      !c.generated &&
      (c.hasDefault || c.identity !== null) &&
      !(request.mode === "update" || givenNames.has(c.name)),
  );
  if (limits?.wide_check && unfilled) notes.push("defaults_not_applied");

  return {
    table,
    supplied,
    rowColumn,
    uniques,
    foreignKeys: fks.map((f) => ({
      name: f.name,
      columns: f.columns,
      refSchema: f.ref_schema,
      refTable: f.ref_table,
      refColumns: f.ref_columns,
      full: f.full,
    })),
    notes,
    key,
  };
}

// ------------------------------------------------------------- failures ---

const sqlstate = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";

/** A refusal of the row itself, as opposed to a broken connection, a timeout or a missing right. */
function isRowFailure(code: string): boolean {
  return (
    code.startsWith("22") || code.startsWith("23") || code.startsWith("P0") || code === "25006"
  );
}

const field = (error: unknown, name: "column" | "constraint"): string | null => {
  const value =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>)[name] : null;
  return typeof value === "string" && value !== "" ? value : null;
};

interface Failure {
  rule: ValidationRule;
  column: string | null;
  constraint: string | null;
}

/** What went wrong with ONE row, from the SQLSTATE, the column and the constraint name. Never the message. */
async function classify(
  db: Queryable,
  prepared: Prepared,
  request: ValidateRequest,
  rowIndex: number,
  error: unknown,
): Promise<Failure> {
  const code = sqlstate(error);
  if (code === "23502")
    return { rule: "not_null", column: field(error, "column"), constraint: null };
  if (code === "23514")
    return { rule: "check", column: null, constraint: field(error, "constraint") };
  if (code === "25006") return { rule: "no_effects", column: null, constraint: null };
  if (code.startsWith("22")) {
    // The database does not say which column: try the row's cells one at a time, each alone.
    const row = request.rows[rowIndex]!;
    for (let i = 0; i < prepared.supplied.length; i++) {
      const column = prepared.supplied[i]!;
      await db.query("SAVEPOINT dc_probe");
      let same = false;
      try {
        await db.query(
          `INSERT INTO ${quoteIdentifier(COPY)} (${quoteIdentifier(column.name)}, ${quoteIdentifier(prepared.rowColumn)}) ` +
            `SELECT CAST($1 AS ${column.castType}), 0`,
          [row[i]],
        );
      } catch (probe) {
        same = sqlstate(probe) === code;
      }
      await db.query("ROLLBACK TO SAVEPOINT dc_probe");
      await db.query("RELEASE SAVEPOINT dc_probe");
      if (same) return { rule: "type", column: column.name, constraint: null };
    }
    return { rule: "type", column: null, constraint: null };
  }
  return { rule: "rejected", column: null, constraint: field(error, "constraint") };
}

// ----------------------------------------------------------------- run ---

interface Counted {
  n: number;
  rows: number[];
}

async function counted(db: Queryable, text: string, values: unknown[] = []): Promise<Counted> {
  const { rows } = await db.query<{ n: number; rows: number[] }>(text, values);
  const row = rows[0];
  return { n: Number(row?.n ?? 0), rows: row?.rows ?? [] };
}

async function run(
  db: Queryable,
  request: ValidateRequest,
  prepared: Prepared,
  deadline: number,
): Promise<ValidationReport> {
  const collector = new IssueCollector();
  const notes = [...prepared.notes];
  const { table, supplied, rowColumn } = prepared;
  const tooLate = () => {
    if (Date.now() > deadline) throw new DatabaseError("timeout");
  };

  // ---- 1. the rows into the copy: the database checks types, domains, NOT NULL and CHECK.
  if (request.mode === "update") {
    const set = new Map(supplied.map((c) => [c.name, { name: c.name, castType: c.castType }]));
    const stored = table.columns.filter((c) => !c.generated);
    const statement = buildUpdateInsert(table, rowColumn, stored, set, prepared.key!);
    const row = request.rows[0]!;
    const values = [
      ...statement.setOrder.map((name) => row[request.columns.indexOf(name)]),
      ...prepared.key!.map((k) => k.value),
    ];
    await db.query("SAVEPOINT dc_batch");
    try {
      const { rows } = await db.query<{ n: number }>(
        `WITH ins AS (${statement.text} RETURNING 1) SELECT count(*)::int AS n FROM ins`,
        values,
      );
      await db.query("RELEASE SAVEPOINT dc_batch");
      if (Number(rows[0]?.n ?? 0) === 0) throw new DatabaseError("not_found");
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      const code = sqlstate(error);
      if (!isRowFailure(code)) throw error;
      await db.query("ROLLBACK TO SAVEPOINT dc_batch");
      const failure = await classify(db, prepared, request, 0, error);
      collector.add(failure.rule, failure.column, failure.constraint, 1);
    }
  } else {
    const typed = supplied.map((c) => ({ name: c.name, castType: c.castType }));
    const insert = buildBatchInsert(rowColumn, typed).text;
    let stopped = false;
    const attempt = async (from: number, to: number): Promise<void> => {
      if (stopped) return;
      tooLate();
      if (collector.failedRows >= VALIDATE_MAX_FAILURES_FOUND) {
        stopped = true;
        return;
      }
      const slice = request.rows.slice(from, to);
      const arrays = [
        ...supplied.map((_, j) => slice.map((r) => r[j] ?? null)),
        slice.map((_, i) => from + i + 1),
      ];
      await db.query("SAVEPOINT dc_batch");
      try {
        await db.query(insert, arrays);
        await db.query("RELEASE SAVEPOINT dc_batch");
      } catch (error) {
        if (!isRowFailure(sqlstate(error))) throw error;
        await db.query("ROLLBACK TO SAVEPOINT dc_batch");
        await db.query("RELEASE SAVEPOINT dc_batch");
        if (to - from === 1) {
          const failure = await classify(db, prepared, request, from, error);
          collector.add(failure.rule, failure.column, failure.constraint, from + 1);
          return;
        }
        const mid = Math.floor((from + to) / 2);
        await attempt(from, mid);
        await attempt(mid, to);
      }
    };
    await attempt(0, request.rows.length);
    if (stopped) notes.push("stopped_early");
  }

  // ---- 2. uniqueness, by read-only queries: inside the copy, then against the table's own rows.
  const given = new Set(
    request.mode === "update" ? table.columns.map((c) => c.name) : request.columns,
  );
  for (const unique of prepared.uniques) {
    if (unique.complex) {
      notes.push("other_unique_indexes");
      continue;
    }
    // A key column the row does not give is filled by the database (or NULL): nothing to compare.
    if (unique.columns.length === 0) continue;
    if (!unique.columns.every((c) => given.has(c))) {
      // A default that is a constant can still make the real insert collide: the report says it was not judged.
      notes.push("defaults_not_applied");
      continue;
    }
    // "Does a row with this value exist?" asked of a hidden column is a way to read it one guess at a time.
    if (unique.columns.some(isSensitiveColumnName)) {
      notes.push("hidden_columns");
      continue;
    }
    tooLate();
    if (request.mode === "insert" && request.rows.length > 1) {
      const inside = await counted(db, buildDuplicatesQuery(rowColumn, unique.columns));
      collector.addMany("unique_in_request", null, unique.name, inside.n, inside.rows);
    }
    const self = request.mode === "update" ? prepared.key : null;
    const existing = await counted(
      db,
      buildExistingQuery(table, rowColumn, unique.columns, self),
      self ? self.map((k) => k.value) : [],
    );
    collector.addMany("unique_existing", null, unique.name, existing.n, existing.rows);
  }

  // ---- 3. foreign keys, by read-only queries on the referenced tables.
  for (const fk of prepared.foreignKeys) {
    if (!fk.columns.every((c) => given.has(c))) {
      notes.push("defaults_not_applied");
      continue;
    }
    if (fk.columns.some(isSensitiveColumnName) || fk.refColumns.some(isSensitiveColumnName)) {
      notes.push("hidden_columns");
      continue;
    }
    tooLate();
    await db.query("SAVEPOINT dc_fk");
    try {
      const orphans = await counted(
        db,
        buildOrphanQuery(
          rowColumn,
          { schema: fk.refSchema, name: fk.refTable },
          fk.columns,
          fk.refColumns,
          fk.full,
        ),
      );
      await db.query("RELEASE SAVEPOINT dc_fk");
      collector.addMany("foreign_key", null, fk.name, orphans.n, orphans.rows);
    } catch (error) {
      // The role may not read the table the key points to (42501): say that this one was not checked.
      if (sqlstate(error) !== "42501") throw error;
      await db.query("ROLLBACK TO SAVEPOINT dc_fk");
      await db.query("RELEASE SAVEPOINT dc_fk");
      notes.push("foreign_key_unreadable");
    }
  }

  return buildReport(request.rows.length, collector, notes);
}

/**
 * Validate a request against a table, on a pooled connection, in a transaction that is read-only before any
 * value goes in and is always rolled back.
 */
export async function validateRows(
  pool: Pool,
  statementTimeoutMs: number,
  request: ValidateRequest,
): Promise<ValidationReport> {
  checkValidateRequest(request);
  const deadline = Date.now() + statementTimeoutMs;
  let prepared: Prepared | undefined;
  return withCheckingTransaction(
    pool,
    statementTimeoutMs,
    async (db) => {
      prepared = await prepare(db, request);
    },
    (db) => run(db, request, prepared!, deadline),
  );
}
