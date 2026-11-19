/**
 * The SQL text of a migration's pieces. Every name goes through `quoteIdentifier` and every
 * literal through `quoteString`; definitions that PostgreSQL printed itself (`pg_get_constraintdef`,
 * `pg_get_indexdef`, `pg_get_expr`) are used as printed. The text is never run here.
 */
import type { ColumnInfo } from "../models.js";
import type { ColumnDdl } from "../ddl.js";
import { quoteIdentifier, quoteQualified, quoteString } from "../sql-text.js";

export const q = quoteIdentifier;
export const qualified = quoteQualified;

/** A collation written as SQL: its schema and its name, each quoted on its own (a name may hold a dot). */
export function collationSql(collation: string, schema: string | null): string {
  return schema === null ? q(collation) : `${q(schema)}.${q(collation)}`;
}

/** `COMMENT ON ... IS 'text'`, or `IS NULL` to remove it. */
export const commentOn = (target: string, comment: string | null): string =>
  `COMMENT ON ${target} IS ${comment === null ? "NULL" : quoteString(comment)};`;

/**
 * A column as `CREATE TABLE` and `ADD COLUMN` write it: name, type, collation, identity or
 * generated expression, default, NOT NULL.
 */
export function columnSql(column: ColumnInfo, detail: ColumnDdl | undefined): string {
  const parts = [q(column.name), column.dataType];
  if (detail?.collation)
    parts.push(`COLLATE ${collationSql(detail.collation, detail.collationSchema)}`);
  if (detail?.identity) {
    parts.push(`GENERATED ${detail.identity === "always" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`);
  } else if (detail?.generated && column.defaultValue !== null) {
    parts.push(
      `GENERATED ALWAYS AS (${column.defaultValue}) ${detail.generated === "virtual" ? "VIRTUAL" : "STORED"}`,
    );
  } else if (column.defaultValue !== null) {
    parts.push(`DEFAULT ${column.defaultValue}`);
  }
  if (!column.nullable) parts.push("NOT NULL");
  return parts.join(" ");
}

/** A default that PostgreSQL evaluates for every row when it is added (so the table is rewritten). */
export const VOLATILE_DEFAULT =
  /\b(nextval|random|clock_timestamp|timeofday|gen_random_uuid|uuid_generate_v\d\w*)\s*\(/i;
