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
import type {
  IndexInfo,
  IndexUsageReport,
  RelationshipInfo,
  TableDetailsEntry,
} from "@datacanvas/database-core";
import { quoteIdent, quoteQualified } from "@/lib/sql-text";

export type HealthCheckId =
  | "no_primary_key"
  | "foreign_key_without_index"
  | "duplicate_index"
  | "redundant_index"
  | "unused_index"
  | "type_mismatch"
  | "nullable_foreign_key"
  | "inconsistent_naming"
  | "fk_column_naming"
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
  "type_mismatch",
  "duplicate_index",
  "redundant_index",
  "unused_index",
  "nullable_foreign_key",
  "inconsistent_naming",
  "fk_column_naming",
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
  unused_index: {
    title: "Indexes that have not been used",
    severity: "warning",
    why: "An index that no query uses still costs disk space and slows every insert, update and delete. This check reads the server's usage counters, which have limits: they only cover the time since they were last reset, they belong to this one server (a standby counts only its own queries, so an index used on the primary can show zero on a replica), and a query that runs once a month or once a year may not have run yet. Indexes that enforce a primary key or a unique or exclusion constraint are never listed. When the counters are younger than a week, or the index is small, findings are shown as information.",
    fix: "Before dropping, check the counters on every server that serves queries, and whether a rare report or a foreign key lookup depends on it. DROP INDEX CONCURRENTLY avoids blocking writes.",
  },
  type_mismatch: {
    title: "Foreign keys whose column types differ",
    severity: "warning",
    why: "A foreign key column and the column it references should have the same type. With different integer sizes the child can never hold a value the parent allows (or the parent outgrows the child), and joins compare values of different types, which can prevent index use and hides mistakes. A difference only in length, or between text and varchar, is shown as information.",
    fix: "Change the child column to the parent's type (plan it: this rewrites the table and takes a lock), or the other way round if the parent is the one that is wrong.",
  },
  nullable_foreign_key: {
    title: "Foreign keys that allow NULL",
    severity: "info",
    why: "A nullable foreign key means the relationship is optional. That is often intended, and sometimes a forgotten NOT NULL.",
    fix: "If every row must have a parent, add NOT NULL to the column(s).",
  },
  inconsistent_naming: {
    title: "Names that break the database's own style",
    severity: "info",
    why: 'Most names here are plain lowercase with underscores. A table or column named with capitals, spaces or other symbols (CreatedAt, "Unit Price") must be wrapped in double quotes in every query, and is easy to get wrong. This is judged against the rest of this database, not against a rule: it is only reported when at least 80% of the names are plain.',
    fix: "Rename to lowercase with underscores, or leave it if the name is fixed by a tool or an external system.",
  },
  fk_column_naming: {
    title: "Foreign key columns not named like the others",
    severity: "info",
    why: "Most foreign key columns here end in _id, which makes the relationships readable from the column names alone. Reported only when at least 80% of the single-column foreign keys follow that pattern (and there are at least five). The odd one out is easy to misread.",
    fix: "Rename the column to end in _id, or leave it if the name carries meaning the pattern would lose.",
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
  /** What the unused-index check was based on, or null when no usage counters were supplied. */
  usage: { statsReset: string | null; inRecovery: boolean; indexes: number } | null;
}

export interface HealthOptions {
  /** Index usage counters. Without them the unused-index check does not run. */
  usage?: IndexUsageReport | null;
  /** The current time, for judging how old the counters are. Defaults to now. */
  now?: Date;
}

/** Counters younger than this are too short a sample to call an index unused. */
export const MIN_STATS_DAYS = 7;
/**
 * An unused index at least this big is worth a warning, if the counters are old enough (or of
 * unknown age) and this is not a standby; otherwise, and for smaller ones, it is information.
 */
export const LARGE_INDEX_BYTES = 10 * 1024 * 1024;
/** Naming checks compare against the database's own style once this share of names follows it. */
export const NAMING_DOMINANCE = 0.8;
/** ... and only when there is enough to judge by. */
export const MIN_NAMES_FOR_STYLE = 10;
export const MIN_FOREIGN_KEYS_FOR_STYLE = 5;

// ---------------------------------------------------------------- helpers ---

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

const qualified = quoteQualified;

/** "1.5 MB": a size in bytes for people. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

// ---- column types ----

/** Types PostgreSQL prints for its built-in types. Anything else (a domain, an enum, an extension's type) is not compared. */
const BUILTIN_TYPES = new Set([
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double precision",
  "money",
  "character varying",
  "character",
  "text",
  "boolean",
  "date",
  "timestamp without time zone",
  "timestamp with time zone",
  "time without time zone",
  "time with time zone",
  "interval",
  "uuid",
  "bytea",
  "json",
  "jsonb",
  "inet",
  "cidr",
  "macaddr",
  "bit",
  "bit varying",
  "xml",
  "oid",
]);

const TEXT_TYPES = new Set(["text", "character varying"]);

/** "character varying(255)" -> "character varying"; "timestamp(3) with time zone" -> "timestamp with time zone". */
export function stripModifiers(dataType: string): string {
  return dataType
    .replace(/\(\s*\d+(?:\s*,\s*\d+)?\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type TypeComparison = "same" | "length_only" | "text_family" | "different" | "unknown";

/**
 * How two column types relate. Only built-in types are judged: a domain over
 * integer and a plain integer look different here but are not a mistake, and a
 * wrong guess would be noise.
 */
export function compareColumnTypes(a: string, b: string): TypeComparison {
  if (a === b) return "same";
  const x = stripModifiers(a);
  const y = stripModifiers(b);
  const isArray = (t: string): boolean => t.endsWith("[]");
  const base = (t: string): string => (isArray(t) ? t.slice(0, -2) : t);
  if (!BUILTIN_TYPES.has(base(x)) || !BUILTIN_TYPES.has(base(y))) return "unknown";
  if (x === y) return "length_only";
  if (isArray(x) === isArray(y) && TEXT_TYPES.has(base(x)) && TEXT_TYPES.has(base(y))) {
    return "text_family";
  }
  return "different";
}

// ---- names ----

/** Lowercase letters, digits and underscores, not starting with a digit: usable without quotes. */
const PLAIN_NAME = /^[a-z_][a-z0-9_]*$/;
export const isPlainName = (name: string): boolean => PLAIN_NAME.test(name);

// ---------------------------------------------------------------- checks ---

export function runHealthChecks(
  entries: TableDetailsEntry[],
  relationships: RelationshipInfo[],
  options: HealthOptions = {},
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

  // 7. Column types of the two ends of a foreign key.
  for (const rel of relationships) {
    const source = byKey.get(JSON.stringify([rel.source.schema, rel.source.table]));
    const target = byKey.get(JSON.stringify([rel.target.schema, rel.target.table]));
    if (!source || !target || source.table.kind !== "table") continue;
    rel.source.columns.forEach((columnName, position) => {
      const from = source.columns.find((c) => c.name === columnName);
      const to = target.columns.find((c) => c.name === rel.target.columns[position]);
      if (!from || !to) return;
      const comparison = compareColumnTypes(from.dataType, to.dataType);
      if (comparison === "same" || comparison === "unknown") return;
      const severity: Severity = comparison === "different" ? "warning" : "info";
      const what =
        comparison === "length_only"
          ? "differ in length or precision"
          : comparison === "text_family"
            ? "are both text but declared differently"
            : "differ";
      add(
        "type_mismatch",
        source,
        `${source.table.name}.${columnName} (${from.dataType}) references ${target.table.name}.${to.name} (${to.dataType}); the types ${what}.`,
        comparison === "different"
          ? `ALTER TABLE ${qualified(source.table.schema, source.table.name)} ALTER COLUMN ${quoteIdent(columnName)} TYPE ${to.dataType};`
          : null,
        severity,
      );
    });
  }

  // 8. Indexes the usage counters say nobody uses.
  const usage = options.usage ?? null;
  if (usage !== null) {
    const now = options.now ?? new Date();
    const resetAt = usage.statsReset === null ? null : new Date(usage.statsReset).getTime();
    const ageDays =
      resetAt === null || Number.isNaN(resetAt) ? null : (now.getTime() - resetAt) / 86_400_000;
    const tooYoung = ageDays !== null && ageDays < MIN_STATS_DAYS;
    const since =
      usage.statsReset === null
        ? "the server started counting (it does not say when)"
        : usage.statsReset.slice(0, 10);

    for (const u of usage.indexes) {
      if (u.scans > 0 || u.backsConstraint || !u.valid) continue;
      const entry = byKey.get(JSON.stringify([u.schema, u.table]));
      if (!entry || entry.table.kind !== "table") continue;
      const index = entry.indexes.find((i) => i.name === u.index);
      if (!index || index.unique || index.primary) continue; // a unique index enforces uniqueness

      // The only index that serves a foreign key's lookups: dropping it slows deletes in the parent.
      const protects = relationships.find(
        (rel) =>
          rel.source.schema === u.schema &&
          rel.source.table === u.table &&
          supportsLookup(index, rel.source.columns) &&
          !entry.indexes.some(
            (other) => other !== index && supportsLookup(other, rel.source.columns),
          ),
      );
      const large = u.sizeBytes >= LARGE_INDEX_BYTES;
      add(
        "unused_index",
        entry,
        `Index ${u.index} on ${u.table} (${formatBytes(u.sizeBytes)}) has not been used since ${since}.` +
          (protects
            ? ` It is the only index that serves the foreign key to ${protects.target.table}, so deleting from ${protects.target.table} would get slower without it.`
            : "") +
          (tooYoung
            ? " The counters are less than a week old, which is too short to be sure."
            : "") +
          (usage.inRecovery
            ? " This server is a standby: its counters only reflect queries run on it, so the index may be used on the primary."
            : ""),
        protects ? null : `DROP INDEX CONCURRENTLY ${qualified(u.schema, u.index)};`,
        large && !tooYoung && !usage.inRecovery ? "warning" : "info",
      );
    }
  }

  // 9. Names that break the database's own style.
  const nameFindings = new Map<TableDetailsEntry, string[]>();
  let nameTotal = 0;
  let namePlain = 0;
  for (const entry of tables) {
    const odd: string[] = [];
    nameTotal += 1;
    if (isPlainName(entry.table.name)) namePlain += 1;
    else odd.push(`table "${entry.table.name}"`);
    for (const column of entry.columns) {
      nameTotal += 1;
      if (isPlainName(column.name)) namePlain += 1;
      else odd.push(`column "${column.name}"`);
    }
    if (odd.length > 0) nameFindings.set(entry, odd);
  }
  if (nameTotal >= MIN_NAMES_FOR_STYLE && namePlain / nameTotal >= NAMING_DOMINANCE) {
    const share = Math.round((namePlain / nameTotal) * 100);
    for (const [entry, odd] of nameFindings) {
      const shown = odd.slice(0, 5).join(", ");
      const more = odd.length > 5 ? ` and ${odd.length - 5} more` : "";
      add(
        "inconsistent_naming",
        entry,
        `${shown}${more} must be quoted in every query, unlike ${share}% of the names in this database.`,
        null,
      );
    }
  }

  // 10. Foreign key columns named unlike the others.
  const singles = relationships.flatMap((rel) => {
    const source = byKey.get(JSON.stringify([rel.source.schema, rel.source.table]));
    const only = rel.source.columns.length === 1 ? rel.source.columns[0] : undefined;
    return source && source.table.kind === "table" && only !== undefined
      ? [{ rel, source, column: only }]
      : [];
  });
  const endsWithId = (name: string): boolean => name.toLowerCase().endsWith("_id");
  if (singles.length >= MIN_FOREIGN_KEYS_FOR_STYLE) {
    const following = singles.filter((s) => endsWithId(s.column)).length;
    if (following / singles.length >= NAMING_DOMINANCE) {
      const share = Math.round((following / singles.length) * 100);
      for (const { rel, source, column } of singles) {
        if (endsWithId(column)) continue;
        add(
          "fk_column_naming",
          source,
          `${source.table.name}.${column} references ${rel.target.table} but does not end in "_id" like ${share}% of the foreign keys here.`,
          null,
        );
      }
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
  return {
    findings,
    checkedTables: tables.length,
    usage:
      usage === null
        ? null
        : {
            statsReset: usage.statsReset,
            inRecovery: usage.inRecovery,
            indexes: usage.indexes.length,
          },
  };
}
