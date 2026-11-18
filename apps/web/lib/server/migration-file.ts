/**
 * The migration file (1.5.2, decision 138): the structure changes that were
 * applied through a connection, as one SQL script that repeats them on another
 * database. Pure text building; `WriteService` keeps the steps.
 *
 * Row changes are only counted: their values are never kept (decision 131), and
 * data is not structure. Every name that goes into a `--` comment is flattened
 * to one line first, because a quoted identifier may hold a line break and the
 * rest of that line would then be SQL.
 */
export interface MigrationStep {
  at: string;
  kind: string;
  table: { schema: string; name: string };
  /** The statements exactly as they ran, ending in a semicolon. */
  sql: string;
}

export interface MigrationInput {
  database: string;
  generatedAt: string;
  steps: MigrationStep[];
  rowChanges: number;
  /** Earlier changes of structure that are not in `steps` (the session keeps the latest ones only). */
  omittedSteps?: number;
}

/** One line of plain text: control characters (line breaks included) become spaces. */
function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
}

export function migrationFilename(database: string, generatedAt: string): string {
  const slug = oneLine(database)
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `datacanvas-${slug || "database"}-${generatedAt.slice(0, 10)}.sql`;
}

export function buildMigration(input: MigrationInput): string {
  const lines = [
    "-- DataCanvas migration: the changes of structure made in one session.",
    `-- Database: ${oneLine(input.database)}`,
    `-- Generated: ${input.generatedAt}`,
  ];
  if (input.rowChanges > 0) {
    const n = input.rowChanges;
    lines.push(
      `-- ${n} row change${n === 1 ? " was" : "s were"} made and ${n === 1 ? "is" : "are"} not part of this file (a migration holds structure, not data).`,
    );
  }
  const omitted = input.omittedSteps ?? 0;
  if (omitted > 0) {
    lines.push(
      `-- WARNING: ${omitted} earlier change${omitted === 1 ? "" : "s"} of structure ${omitted === 1 ? "is" : "are"} NOT in this file (only the latest ones are kept), so it cannot be run on a fresh database as it is.`,
    );
  }
  lines.push("");
  if (input.steps.length === 0) {
    lines.push("-- No changes of structure were made in this session.", "");
    return lines.join("\n");
  }
  lines.push("BEGIN;", "");
  for (const step of input.steps) {
    lines.push(
      `-- ${step.at} ${oneLine(step.kind)} ${oneLine(`${step.table.schema}.${step.table.name}`)}`,
    );
    lines.push(step.sql.trim(), "");
  }
  lines.push("COMMIT;", "");
  return lines.join("\n");
}
