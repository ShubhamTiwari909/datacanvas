/**
 * Is the plan still about the same table? A preview can wait five minutes, and
 * a table dropped and created again under the same name in between would
 * otherwise receive the change (a replacement with the same column names would
 * even pass every check made at preview time).
 *
 * At preview the planner records, for each relation it checked, its `pg_class`
 * oid and the position (`attnum`) and type (length and precision too) of each column the change names. At apply,
 * inside the write transaction and BEFORE any statement, the relation is
 * locked (so it cannot be dropped, renamed or altered while the statements run)
 * and the recorded identity is compared with what is there now. A mismatch
 * stops everything with a fixed message and nothing is written.
 */
import {
  DatabaseError,
  quoteQualified,
  type PlanGuardRelation,
  type PlannedChange,
} from "@datacanvas/database-core";
import type { WriteClient } from "../connection/write.js";
import type { CatalogTable } from "./catalog.js";

/** The lock modes a guard may take, from this fixed table only. */
const LOCK_SQL: Record<Exclude<PlanGuardRelation["lock"], "none">, string> = {
  row_exclusive: "ROW EXCLUSIVE",
  share: "SHARE",
  access_exclusive: "ACCESS EXCLUSIVE",
};

export const STALE_STRUCTURE_MESSAGE =
  "The table changed since you previewed this, so nothing was changed. Preview again.";

/** The identity of a loaded table, with the columns the change names. */
export function guardRelation(
  table: Pick<CatalogTable, "schema" | "name" | "oid" | "columns">,
  columns: readonly string[],
  lock: PlanGuardRelation["lock"],
): PlanGuardRelation {
  const pinned = [...new Set(columns)].flatMap((name) => {
    const column = table.columns.find((c) => c.name === name);
    return column ? [{ name, attnum: column.attnum, dataType: column.dataType }] : [];
  });
  return { schema: table.schema, name: table.name, oid: table.oid, columns: pinned, lock };
}

/**
 * Lock, then check. Locked relations come first, in a fixed order, so two
 * changes cannot lock the same tables in opposite orders.
 */
export async function verifyGuard(db: WriteClient, plan: PlannedChange): Promise<void> {
  const relations = [...(plan.guard?.relations ?? [])].sort(
    (a, b) =>
      Number(a.lock === "none") - Number(b.lock === "none") ||
      `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`),
  );
  const stale = (): DatabaseError =>
    plan.category === "row"
      ? new DatabaseError("row_changed")
      : new DatabaseError("invalid_change", { message: STALE_STRUCTURE_MESSAGE });

  for (const relation of relations) {
    if (relation.lock !== "none") {
      const mode = Object.hasOwn(LOCK_SQL, relation.lock) ? LOCK_SQL[relation.lock] : undefined;
      if (!mode) throw new DatabaseError("unexpected");
      await db.query(
        `LOCK TABLE ${quoteQualified(relation.schema, relation.name)} IN ${mode} MODE`,
      );
    }
    const found = await db.query(
      `SELECT c.oid::text AS oid
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [relation.schema, relation.name],
    );
    if (found.rows[0]?.oid !== relation.oid) throw stale();
    if (relation.columns.length === 0) continue;
    const current = await db.query(
      `SELECT a.attname::text AS name, a.attnum::int AS attnum, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
       FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped`,
      [relation.oid],
    );
    const have = new Map(
      current.rows.map((r) => [
        String(r.name),
        { attnum: Number(r.attnum), dataType: String(r.data_type) },
      ]),
    );
    if (
      !relation.columns.every((c) => {
        const now = have.get(c.name);
        return now !== undefined && now.attnum === c.attnum && now.dataType === c.dataType;
      })
    )
      throw stale();
  }
}
