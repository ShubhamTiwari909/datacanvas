/**
 * Model health checks: things in a database's STRUCTURE that are often
 * mistakes or that cost performance. Pure functions over metadata the app
 * already reads (tables, columns, constraints, indexes, foreign keys); no
 * table rows are ever read and nothing is changed.
 *
 * These are hints, not verdicts. Every finding says why it matters and what a
 * fix would look like, but only the person who knows the database can decide
 * (an "optional" relationship is a nullable foreign key on purpose; a table
 * with 3 rows does not need an index). Suggested statements are shown as text
 * to copy. DataCanvas never runs them.
 */
import type { IndexInfo, RelationshipInfo, TableDetailsEntry } from "@datacanvas/database-core";

export type HealthCheckId =
  | "no_primary_key"
  | "foreign_key_without_index"
  | "duplicate_index"
  | "redundant_index"
  | "nullable_foreign_key"
  | "wide_table";

export type Severity = "warning" | "info";

export interface HealthCheckInfo {
  title: string;
  /** Usual severity (a finding can be downgraded, see `foreign_key_without_index`). */
  severity: Severity;
  why: string;
  fix: string;
}

/** Fixed order: also the order findings are grouped in. */
export const CHECK_ORDER: HealthCheckId[] = [
  "no_primary_key",
  "foreign_key_without_index",
  "duplicate_index",
  "redundant_index",
  "nullable_foreign_key",
  "wide_table",
];

export const CHECKS: Record<HealthCheckId, HealthCheckInfo> = {
  no_primary_key: {
    title: "Tables without a primary key",
    severity: "warning",
    why: "Without a primary key rows cannot be told apart reliably: updates and deletes can hit duplicates, replication and many tools need one, and relationships cannot point at the table.",
    fix: "Add a primary key on a column (or set of columns) that identifies each row.",
  },
  foreign_key_without_index: {
    title: "Foreign keys without a supporting index",
    severity: "warning",
    why: "PostgreSQL does not index the referencing side of a foreign key. Deleting or updating a parent row then scans the whole child table, and joins on the key are slow. It rarely matters on small tables, so those are shown as information.",
    fix: "Create an index that starts with the foreign key's columns.",
  },
  duplicate_index: {
    title: "Duplicate indexes",
    severity: "warning",
    why: "Two indexes with the same definition double the disk space and slow every write, and the second one never helps a query.",
    fix: "Keep one. If the extra index backs a unique constraint, drop the constraint instead of the index.",
  },
  redundant_index: {
    title: "Possibly redundant indexes",
    severity: "info",
    why: "An index on (a) is usually covered by another index starting with (a, b). The shorter one costs space and write time. It can still matter when operator classes, collations or sort orders differ.",
    fix: "Check how the index is used (for example pg_stat_user_indexes) before dropping it.",
  },
  nullable_foreign_key: {
    title: "Foreign keys that allow NULL",
    severity: "info",
    why: "A nullable foreign key means the relationship is optional. That is often intended, and sometimes a forgotten NOT NULL.",
    fix: "If every row must have a parent, add NOT NULL to the column(s).",
  },
  wide_table: {
    title: "Very wide tables",
    severity: "info",
    why: "Tables with many columns are hard to understand and often mix several concepts (or hold repeated groups such as phone1, phone2).",
    fix: "Consider splitting rarely used or repeated columns into related tables.",
  },
};

/** Tables with more columns than this are reported as wide. */
export const WIDE_TABLE_COLUMNS = 50;
/** A missing foreign-key index is only a warning for tables at least this big (or of unknown size). */
export const SMALL_TABLE_ROWS = 1000;

export interface HealthFinding {
  check: HealthCheckId;
  severity: Severity;
  schema: string;
  table: string;
  /** One sentence about this specific table. */
  message: string;
  /** SQL to copy, or null when no safe statement can be suggested. */
  suggestion: string | null;
  estimatedRows: number | null;
}

export interface HealthReport {
  findings: HealthFinding[];
  /** Tables (not views) that were examined. */
  checkedTables: number;
}

// ---------------------------------------------------------------- helpers ---

/** Quote an SQL identifier: "name", with any double quote inside doubled. Used only for suggestions shown as text. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const QUOTED_NAME = /^"(?:[^"]|"")*"$/;

/**
 * Index key columns come from pg_get_indexdef, which quotes a name when it
 * needs it ("select", "Unit Price"), while constraint columns are raw names.
 * Compare apples with apples: strip one layer of quoting when the whole text
 * is a single quoted name. Expressions (lower(email)) are left alone.
 */
export function indexColumnName(text: string): string {
  return QUOTED_NAME.test(text) ? text.slice(1, -1).replace(/""/g, '"') : text;
}

/** The text after WHERE in a CREATE INDEX statement (a partial index), or null. */
function predicateOf(index: IndexInfo): string | null {
  const match = /\sWHERE\s(.+)$/s.exec(index.definition ?? "");
  return match?.[1]?.trim() ?? null;
}

function hasIncludeColumns(index: IndexInfo): boolean {
  return /\sINCLUDE\s*\(/.test(index.definition ?? "");
}

const keyColumns = (index: IndexInfo): string[] => index.columns.map(indexColumnName);

/** Can this index serve lookups by equality on the given columns? (Leading columns, any order, whole table.) */
function supportsLookup(index: IndexInfo, columns: string[]): boolean {
  if (index.method !== "btree" && index.method !== "hash") return false;
  if (predicateOf(index) !== null) return false; // a partial index covers only some rows
  const lead = keyColumns(index).slice(0, columns.length);
  return lead.length === columns.length && columns.every((c) => lead.includes(c));
}

const signature = (index: IndexInfo): string =>
  JSON.stringify([
    index.method,
    index.unique,
    keyColumns(index),
    predicateOf(index),
    hasIncludeColumns(index) ? index.definition : null,
  ]);

const qualified = (schema: string, table: string): string =>
  `${quoteIdent(schema)}.${quoteIdent(table)}`;

// ---------------------------------------------------------------- checks ---

export function runHealthChecks(
  entries: TableDetailsEntry[],
  relationships: RelationshipInfo[],
): HealthReport {
  const byKey = new Map(entries.map((e) => [JSON.stringify([e.table.schema, e.table.name]), e]));
  const findings: HealthFinding[] = [];
  const add = (
    check: HealthCheckId,
    entry: TableDetailsEntry,
    message: string,
    suggestion: string | null,
    severity: Severity = CHECKS[check].severity,
  ): void => {
    findings.push({
      check,
      severity,
      schema: entry.table.schema,
      table: entry.table.name,
      message,
      suggestion,
      estimatedRows: entry.table.estimatedRowCount,
    });
  };

  const tables = entries.filter((e) => e.table.kind === "table");

  for (const entry of tables) {
    const { schema, name } = entry.table;

    // 1. No primary key.
    if (!entry.constraints.some((c) => c.kind === "primary_key")) {
      add("no_primary_key", entry, `${name} has no primary key.`, null);
    }

    // 2. Wide table.
    if (entry.columns.length > WIDE_TABLE_COLUMNS) {
      add("wide_table", entry, `${name} has ${entry.columns.length} columns.`, null);
    }

    // 3. Identical indexes: same method, uniqueness, key columns, predicate and INCLUDE.
    const groups = new Map<string, IndexInfo[]>();
    for (const index of entry.indexes) {
      const key = signature(index);
      groups.set(key, [...(groups.get(key) ?? []), index]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const names = group.map((i) => i.name);
      // Only a plain, non-unique, non-primary index can be dropped on its own.
      const droppable = group.find((i) => !i.unique && !i.primary);
      add(
        "duplicate_index",
        entry,
        `Indexes ${names.join(", ")} on ${name} have the same definition.`,
        droppable ? `DROP INDEX ${qualified(schema, droppable.name)};` : null,
      );
    }

    // 4. Redundant prefix: a plain btree index whose columns start another btree index.
    const duplicates = new Set(
      [...groups.values()].filter((g) => g.length > 1).flatMap((g) => g.map((i) => i.name)),
    );
    for (const index of entry.indexes) {
      if (
        duplicates.has(index.name) ||
        index.method !== "btree" ||
        index.unique ||
        index.primary ||
        predicateOf(index) !== null ||
        hasIncludeColumns(index)
      ) {
        continue;
      }
      const mine = keyColumns(index);
      const cover = entry.indexes.find((other) => {
        if (other === index || other.method !== "btree" || predicateOf(other) !== null)
          return false;
        const theirs = keyColumns(other);
        return theirs.length > mine.length && mine.every((c, i) => theirs[i] === c);
      });
      if (cover) {
        add(
          "redundant_index",
          entry,
          `Index ${index.name} (${mine.join(", ")}) is covered by ${cover.name} (${keyColumns(cover).join(", ")}).`,
          `DROP INDEX ${qualified(schema, index.name)};`,
        );
      }
    }
  }

  // 5 and 6. Foreign keys: missing index, nullable columns.
  for (const rel of relationships) {
    const entry = byKey.get(JSON.stringify([rel.source.schema, rel.source.table]));
    if (!entry || entry.table.kind !== "table") continue;
    const columns = rel.source.columns;
    const list = columns.join(", ");

    if (!entry.indexes.some((index) => supportsLookup(index, columns))) {
      const rows = entry.table.estimatedRowCount;
      const small = rows !== null && rows < SMALL_TABLE_ROWS;
      add(
        "foreign_key_without_index",
        entry,
        `${entry.table.name}(${list}) references ${rel.target.table} but no index starts with ${columns.length === 1 ? "that column" : "those columns"}.`,
        `CREATE INDEX ON ${qualified(entry.table.schema, entry.table.name)} (${columns.map(quoteIdent).join(", ")});`,
        small ? "info" : "warning",
      );
    }

    const nullable = columns.filter(
      (c) => entry.columns.find((col) => col.name === c)?.nullable === true,
    );
    if (nullable.length > 0) {
      add(
        "nullable_foreign_key",
        entry,
        `${entry.table.name}(${nullable.join(", ")}) can be NULL, so the relationship to ${rel.target.table} is optional.`,
        null,
      );
    }
  }

  const severityRank: Record<Severity, number> = { warning: 0, info: 1 };
  findings.sort(
    (a, b) =>
      CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check) ||
      severityRank[a.severity] - severityRank[b.severity] ||
      a.schema.localeCompare(b.schema) ||
      a.table.localeCompare(b.table) ||
      a.message.localeCompare(b.message),
  );
  return { findings, checkedTables: tables.length };
}
