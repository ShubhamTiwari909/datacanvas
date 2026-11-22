/**
 * The pre-flight of a migration against the data (`docs/advanced-data-workspace-plan.md`, section 6.3):
 * how many rows would make "set NOT NULL", "add a unique key", "add a foreign key" or "add a column that
 * cannot be NULL" fail. Four fixed query shapes in a read-only transaction. Every name in a check is looked up
 * in the catalog of THIS database and quoted; a table or a column that is not there is `missing`, not an error;
 * nothing but a count comes back, and nothing about a row.
 *
 *   nulls       SELECT count(*) FROM "s"."t" WHERE "c" IS NULL
 *   duplicates  SELECT count(*) FROM (SELECT 1 FROM "s"."t" WHERE "a" IS NOT NULL AND ... GROUP BY "a", ... HAVING count(*) > 1) d
 *   orphans     SELECT count(*) FROM "s"."t" AS c WHERE c."a" IS NOT NULL AND ... AND NOT EXISTS (SELECT 1 FROM "rs"."rt" AS r WHERE r."k" = c."a" AND ...)
 *   rows        SELECT CASE WHEN EXISTS (SELECT 1 FROM "s"."t") THEN 1 ELSE 0 END
 */
import {
  DatabaseError,
  PREFLIGHT_MAX_CHECKS,
  quoteIdentifier,
  isSensitiveColumnName,
  quoteQualified,
  type PreflightCheck,
  type PreflightResult,
} from "@datacanvas/database-core";
import { listColumns } from "./columns.js";
import { listTablesByRef } from "./tables.js";
import type { Queryable } from "./types.js";

const code = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";

/** The statement for one check whose names were found in the catalog. Pure: names in, text out. */
export function buildPreflightQuery(check: PreflightCheck): string {
  const table = quoteQualified(check.schema, check.table);
  switch (check.kind) {
    case "nulls":
      return `SELECT count(*)::text AS n FROM ${table} WHERE ${quoteIdentifier(check.column)} IS NULL`;
    case "duplicates": {
      const columns = check.columns.map(quoteIdentifier);
      return (
        `SELECT count(*)::text AS n FROM (SELECT 1 FROM ${table} ` +
        `WHERE ${columns.map((c) => `${c} IS NOT NULL`).join(" AND ")} ` +
        `GROUP BY ${columns.join(", ")} HAVING count(*) > 1) AS d`
      );
    }
    case "orphans": {
      const present = check.columns.map((c) => `c.${quoteIdentifier(c)} IS NOT NULL`).join(" AND ");
      const same = check.columns
        .map((c, i) => `r.${quoteIdentifier(check.refColumns[i]!)} = c.${quoteIdentifier(c)}`)
        .join(" AND ");
      return (
        `SELECT count(*)::text AS n FROM ${table} AS c WHERE ${present} AND NOT EXISTS ` +
        `(SELECT 1 FROM ${quoteQualified(check.refSchema, check.refTable)} AS r WHERE ${same})`
      );
    }
    case "rows":
      return `SELECT CASE WHEN EXISTS (SELECT 1 FROM ${table}) THEN '1' ELSE '0' END AS n`;
  }
}

/** Is the shape of a check one the adapter will build a statement for? */
function checkShape(check: PreflightCheck): void {
  const bad = () => new DatabaseError("invalid_request");
  if (check.kind === "duplicates" || check.kind === "orphans") {
    if (check.columns.length < 1 || check.columns.length > 32) throw bad();
    if (new Set(check.columns).size !== check.columns.length) throw bad();
  }
  if (check.kind === "orphans" && check.refColumns.length !== check.columns.length) throw bad();
}

export async function runPreflight(
  db: Queryable,
  checks: readonly PreflightCheck[],
): Promise<PreflightResult[]> {
  if (checks.length > PREFLIGHT_MAX_CHECKS) throw new DatabaseError("invalid_request");
  for (const check of checks) checkShape(check);

  // The columns of each table asked about, once; null when it is not a table of this database.
  const known = new Map<string, Set<string> | null>();
  const columnsOf = async (schema: string, name: string): Promise<Set<string> | null> => {
    const key = JSON.stringify([schema, name]);
    if (!known.has(key)) {
      const [table] = await listTablesByRef(db, [{ schema, name }]);
      // Only a table has rows that a constraint is checked against.
      const isTable = table !== undefined && table.kind === "table";
      known.set(
        key,
        isTable ? new Set((await listColumns(db, schema, name)).map((c) => c.name)) : null,
      );
    }
    return known.get(key)!;
  };

  const results: PreflightResult[] = [];
  for (const check of checks) {
    // A count on a hidden column (shared values, rows that match another table) would read it back.
    const named =
      check.kind === "nulls"
        ? [check.column]
        : check.kind === "rows"
          ? []
          : check.kind === "duplicates"
            ? check.columns
            : [...check.columns, ...check.refColumns];
    if (named.some(isSensitiveColumnName)) {
      results.push({ status: "hidden", count: 0 });
      continue;
    }
    const own = await columnsOf(check.schema, check.table);
    const ownNames =
      check.kind === "nulls" ? [check.column] : check.kind === "rows" ? [] : check.columns;
    let present = own !== null && ownNames.every((c) => own.has(c));
    if (present && check.kind === "orphans") {
      const ref = await columnsOf(check.refSchema, check.refTable);
      present = ref !== null && check.refColumns.every((c) => ref.has(c));
    }
    if (!present) {
      results.push({ status: "missing", count: 0 });
      continue;
    }
    await db.query("SAVEPOINT dc_preflight");
    try {
      const { rows } = await db.query<{ n: string }>(buildPreflightQuery(check));
      await db.query("RELEASE SAVEPOINT dc_preflight");
      const count = Number(rows[0]?.n ?? 0);
      results.push({ status: count > 0 ? "fails" : "ok", count });
    } catch (error) {
      const sqlstate = code(error);
      await db.query("ROLLBACK TO SAVEPOINT dc_preflight");
      await db.query("RELEASE SAVEPOINT dc_preflight");
      // Our statement timeout fired: this check is too slow, the others still run.
      if (sqlstate === "57014") {
        results.push({ status: "too_slow", count: 0 });
        continue;
      }
      // Two columns that cannot be compared (a foreign key between types): a fixed message, never the database's.
      if (sqlstate.startsWith("42") && sqlstate !== "42501") {
        throw new DatabaseError("invalid_request", { cause: error });
      }
      throw error;
    }
  }
  return results;
}
