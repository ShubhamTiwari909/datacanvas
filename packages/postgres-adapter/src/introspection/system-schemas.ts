/**
 * Which schemas count as "system" and are hidden from the user.
 *
 * A SQL predicate, reused by every query so they all agree. `pg_catalog`,
 * `pg_toast`, `pg_temp_N` and friends all start with "pg_"; `information_schema`
 * is the SQL-standard metadata schema. The backslash escapes the underscore,
 * which is otherwise a single-character wildcard in LIKE.
 *
 * `{column}` is replaced with a column expression by `excludeSystemSchemas`.
 * Only fixed strings from this codebase are ever substituted, never user input.
 */
export function excludeSystemSchemas(column: string): string {
  return `${column} NOT LIKE 'pg\\_%' ESCAPE '\\' AND ${column} <> 'information_schema'`;
}
