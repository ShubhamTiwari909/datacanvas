import type { Cardinality, ReferentialAction, RelationshipInfo } from "@datacanvas/database-core";
import type { Queryable } from "./types.js";
import { excludeSystemSchemas } from "./system-schemas.js";

/**
 * Foreign keys are rows of pg_constraint with contype = 'f':
 *   conrelid / conkey   = the REFERENCING table and its column numbers,
 *   confrelid / confkey = the REFERENCED table and its column numbers.
 * Column numbers are turned into names exactly as in constraints.ts.
 *
 * confdeltype / confupdtype are one-letter codes for ON DELETE / ON UPDATE
 * (see `referentialAction` below).
 *
 * conparentid = 0 skips the copies of a foreign key that PostgreSQL makes on
 * every partition of a partitioned table, so each real relationship appears once.
 *
 * Only relationships between user tables are returned (both ends outside the
 * system schemas).
 *
 * This is the ONLY source of relationships: real, declared constraints. Table
 * and column names are never used to guess.
 */
const FOREIGN_KEYS_SQL = `
  SELECT
    con.conname::text AS name,
    sn.nspname::text AS source_schema,
    sc.relname::text AS source_table,
    ARRAY(
      SELECT a.attname::text
      FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      ORDER BY k.ord
    ) AS source_columns,
    tn.nspname::text AS target_schema,
    tc.relname::text AS target_table,
    ARRAY(
      SELECT a.attname::text
      FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
      ORDER BY k.ord
    ) AS target_columns,
    con.confdeltype::text AS on_delete,
    con.confupdtype::text AS on_update
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class sc ON sc.oid = con.conrelid
  JOIN pg_catalog.pg_namespace sn ON sn.oid = sc.relnamespace
  JOIN pg_catalog.pg_class tc ON tc.oid = con.confrelid
  JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
  WHERE con.contype = 'f'
    AND con.conparentid = 0
    AND ${excludeSystemSchemas("sn.nspname")}
    AND ${excludeSystemSchemas("tn.nspname")}
  ORDER BY sn.nspname, sc.relname, con.conname
`;

/**
 * Every unique index's key columns, per table. Used only to decide whether a
 * foreign key is one-to-one (see `deriveCardinality`).
 *
 * We use unique INDEXES (a unique constraint is backed by one, as is a primary
 * key) because that also catches uniqueness declared with CREATE UNIQUE INDEX.
 * But some unique indexes do not guarantee uniqueness of the whole table, so
 * they are excluded:
 *   - partial indexes (indpred IS NOT NULL: "unique among rows WHERE ..."),
 *   - expression indexes (indexprs IS NOT NULL: unique on lower(col), not col),
 *   - invalid indexes (a failed CREATE INDEX CONCURRENTLY).
 *
 * indkey is the list of indexed column numbers and, unlike ordinary arrays,
 * starts at position 0, hence generate_series(0, ...).
 */
const UNIQUE_KEYS_SQL = `
  SELECT
    n.nspname::text AS schema,
    t.relname::text AS table,
    ARRAY(
      SELECT a.attname::text
      FROM generate_series(0, ix.indnkeyatts - 1) AS g(pos)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ix.indkey[g.pos]
      ORDER BY g.pos
    ) AS columns
  FROM pg_catalog.pg_index ix
  JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE ix.indisunique
    AND ix.indisvalid
    AND ix.indpred IS NULL
    AND ix.indexprs IS NULL
    AND ${excludeSystemSchemas("n.nspname")}
`;

interface ForeignKeyRow {
  name: string;
  source_schema: string;
  source_table: string;
  source_columns: string[];
  target_schema: string;
  target_table: string;
  target_columns: string[];
  on_delete: string;
  on_update: string;
}

interface UniqueKeyRow {
  schema: string;
  table: string;
  columns: string[];
}

/** Translate PostgreSQL's one-letter referential action codes. */
export function referentialAction(code: string): ReferentialAction {
  switch (code) {
    case "r":
      return "restrict";
    case "c":
      return "cascade";
    case "n":
      return "set_null";
    case "d":
      return "set_default";
    default:
      return "no_action"; // "a"
  }
}

/**
 * Decide whether a foreign key is one-to-one or many-to-one.
 *
 * A foreign key is one-to-one when some unique key of the referencing table
 * is made only of columns that are part of the foreign key. Reason: if rows
 * are unique on that smaller key, they are unique on the whole foreign-key
 * column set too, so no two rows can point at the same target row.
 *
 * Examples (foreign key = user_id):
 *   UNIQUE (user_id)               -> one-to-one
 *   PRIMARY KEY (user_id)          -> one-to-one (typical "profile" table)
 *   UNIQUE (user_id, kind)         -> many-to-one (a user can have several kinds)
 *   no unique key                  -> many-to-one
 */
export function deriveCardinality(
  foreignKeyColumns: readonly string[],
  uniqueKeys: ReadonlyArray<readonly string[]>,
): Cardinality {
  const fk = new Set(foreignKeyColumns);
  const oneToOne = uniqueKeys.some(
    (key) => key.length > 0 && key.every((column) => fk.has(column)),
  );
  return oneToOne ? "one-to-one" : "many-to-one";
}

export async function listRelationships(db: Queryable): Promise<RelationshipInfo[]> {
  const [foreignKeys, uniqueKeys] = await Promise.all([
    db.query<ForeignKeyRow>(FOREIGN_KEYS_SQL),
    db.query<UniqueKeyRow>(UNIQUE_KEYS_SQL),
  ]);

  // Group unique keys by table so each foreign key only looks at its own table's keys.
  const keysByTable = new Map<string, string[][]>();
  for (const row of uniqueKeys.rows) {
    const id = `${row.schema}.${row.table}`;
    const keys = keysByTable.get(id) ?? [];
    keys.push(row.columns);
    keysByTable.set(id, keys);
  }

  return foreignKeys.rows.map((row) => ({
    name: row.name,
    source: { schema: row.source_schema, table: row.source_table, columns: row.source_columns },
    target: { schema: row.target_schema, table: row.target_table, columns: row.target_columns },
    cardinality: deriveCardinality(
      row.source_columns,
      keysByTable.get(`${row.source_schema}.${row.source_table}`) ?? [],
    ),
    onDelete: referentialAction(row.on_delete),
    onUpdate: referentialAction(row.on_update),
  }));
}
