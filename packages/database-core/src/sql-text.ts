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

/**
 * A string literal for SQL text that is written to a file (a comment, a default): single quotes
 * doubled, and a string with a backslash becomes an `E''` literal with the backslashes doubled, so
 * it means the same whatever `standard_conforming_strings` is set to. PostgreSQL cannot hold a NUL
 * character in text, so one is refused here rather than written.
 */
export function quoteString(value: string): string {
  if (value.includes("\0")) throw new RangeError("A text value cannot contain a NUL character.");
  const quoted = value.replace(/'/g, "''");
  return value.includes("\\") ? `E'${quoted.replace(/\\/g, "\\\\")}'` : `'${quoted}'`;
}
