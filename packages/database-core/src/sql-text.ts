/**
 * Building SQL TEXT safely. The one place identifiers are quoted: the
 * PostgreSQL adapter uses it to build the queries it runs, and the web app uses
 * it for the statements it only SHOWS (suggested indexes, generated joins).
 *
 * Quoting matters because a name such as `a b` or `"; DROP TABLE x; --` must
 * become one harmless identifier wherever it ends up.
 */

/** Quote an SQL identifier: "name", with any double quote inside doubled. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** `"schema"."table"`. */
export function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}
