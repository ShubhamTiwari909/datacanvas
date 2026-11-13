/**
 * Helpers for building SQL TEXT that is shown to the user to copy (suggested
 * indexes, generated joins). DataCanvas never runs this text: it has no way to
 * execute SQL. Quoting still matters, because a table named `a b` or
 * `"; DROP TABLE x; --` must become a harmless identifier in what the user
 * pastes into their own tool.
 */

/** Quote an SQL identifier: "name", with any double quote inside doubled. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** `"schema"."table"`. */
export function quoteQualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}
