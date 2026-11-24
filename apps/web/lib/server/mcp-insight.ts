/**
 * What the app COMPUTES about a structure, as Claude gets it (`docs/mcp-server-plan.md`, section 23; decision 169): the health
 * checks, the foreign-key path between two tables, the difference between two connections, a migration written as text, and
 * the schema as a document. Pure functions and one loader: nothing here runs a statement, writes, or reads a row.
 *
 * Every structure that reaches Claude passes `redactEntries` / `redactStructure` first: a default, a comment or a definition
 * that belongs to a HIDDEN column (a sensitive-looking name) can hold the very value that is hidden, so it is left out. The
 * views, functions and the other objects are not compared or described at all (a function body is code, and code holds
 * literals). Every answer is bounded, and says so when it left something out.
 */
import {
  isSensitiveColumnName,
  type DatabaseAdapter,
  type DatabaseStructure,
  type RelationshipInfo,
  type SchemaDiff,
  type TableDetailsEntry,
  type TableRef,
} from "@datacanvas/database-core";
import type { MigrationPlan, RenameSuggestion } from "@datacanvas/database-core";
import { findPaths, buildJoinSql, type PathSearch } from "@/features/paths/path-finder";
import { CHECKS, CHECK_ORDER, type HealthReport } from "@/features/health/health-checks";
import { sensitiveNamesIn } from "./mcp-data";

/** The most tables one analysis reads (the Health tab's limit). */
export const MAX_ANALYSED_TABLES = 2000;
/** The most findings, changes and steps one answer lists. */
export const MAX_LISTED = 200;
/** The most characters of SQL one migration answer holds (the rest of the steps are listed without their SQL). */
export const MAX_SCRIPT_CHARS = 100_000;

const BATCH = 500;

const hidden = (name: string): boolean => isSensitiveColumnName(name);
const mentionsHidden = (columns: readonly string[], text: string | null): boolean =>
  columns.some(hidden) || (text !== null && sensitiveNamesIn(text).length > 0);

/** The details of the tables (all kinds), at most `MAX_ANALYSED_TABLES`, of one schema or all. */
export async function loadEntries(
  adapter: DatabaseAdapter,
  schema?: string,
): Promise<{ entries: TableDetailsEntry[]; skipped: number; relationships: RelationshipInfo[] }> {
  const schemas = schema ? [schema] : (await adapter.getSchemas()).map((s) => s.name);
  const refs: TableRef[] = [];
  for (const name of schemas) {
    for (const t of await adapter.getTables(name)) refs.push({ schema: t.schema, name: t.name });
  }
  const used = refs.slice(0, MAX_ANALYSED_TABLES);
  const entries: TableDetailsEntry[] = [];
  for (let start = 0; start < used.length; start += BATCH) {
    entries.push(...(await adapter.getTablesDetails(used.slice(start, start + BATCH))));
  }
  const relationships = await adapter.getRelationships();
  return { entries, skipped: refs.length - used.length, relationships };
}

/** Details with the default, comment and definitions of a hidden column left out. */
export function redactEntries(entries: readonly TableDetailsEntry[]): TableDetailsEntry[] {
  return entries.map((e) => ({
    ...e,
    columns: e.columns.map((c) =>
      hidden(c.name) ? { ...c, defaultValue: null, comment: null } : c,
    ),
    constraints: e.constraints.map((c) =>
      mentionsHidden(c.columns, c.definition) ? { ...c, definition: null } : c,
    ),
    indexes: e.indexes.map((i) =>
      mentionsHidden(i.columns, i.definition) ? { ...i, definition: null } : i,
    ),
  }));
}

/** A structure for a comparison or a migration: tables redacted as above, and no views, functions or other objects. */
export function redactStructure(structure: DatabaseStructure): DatabaseStructure {
  return {
    ...structure,
    tables: structure.tables.map((t) => ({
      ...t,
      columns: t.columns.map((c) =>
        hidden(c.name) ? { ...c, defaultValue: null, comment: null } : c,
      ),
      constraints: t.constraints.map((c) =>
        mentionsHidden(c.columns, c.definition) ? { ...c, definition: null } : c,
      ),
      indexes: t.indexes.map((i) =>
        mentionsHidden(i.columns, i.definition) ? { ...i, definition: null } : i,
      ),
    })),
    objects: null,
  };
}

export const OBJECTS_NOT_COMPARED =
  "Views, functions, triggers, types, sequences, extensions and policies are not compared (a function body is code and can hold a literal). Defaults, comments and check definitions of hidden columns are left out.";

// --------------------------------------------------------------------- health

export function shapeHealth(report: HealthReport, skipped: number) {
  const counts: Record<string, number> = {};
  for (const f of report.findings) counts[f.check] = (counts[f.check] ?? 0) + 1;
  const order = new Map(CHECK_ORDER.map((id, i) => [id, i]));
  const sorted = [...report.findings].sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "warning" ? -1 : 1) ||
      (order.get(a.check) ?? 0) - (order.get(b.check) ?? 0) ||
      a.schema.localeCompare(b.schema) ||
      a.table.localeCompare(b.table),
  );
  return {
    checkedTables: report.checkedTables,
    skippedTables: skipped,
    usage: report.usage,
    counts: Object.entries(counts).map(([check, count]) => ({
      check,
      title: CHECKS[check as keyof typeof CHECKS]?.title ?? check,
      count,
    })),
    findings: sorted.slice(0, MAX_LISTED).map((f) => ({
      check: f.check,
      severity: f.severity,
      schema: f.schema,
      table: f.table,
      message: f.message,
      suggestion: f.suggestion,
    })),
    truncated: sorted.length > MAX_LISTED,
  };
}

// ---------------------------------------------------------------------- paths

export function shapePaths(search: PathSearch, relationships: RelationshipInfo[]) {
  if (search.status === "same_table") return { status: "same_table" as const, paths: [] };
  if (search.status === "none")
    return { status: "none" as const, paths: [], related: relationships.length };
  return {
    status: "found" as const,
    joins: search.length,
    truncated: search.truncated,
    paths: search.paths.map((p) => ({
      tables: p.tables.map((t) => `${t.schema}.${t.table}`),
      multipliesRows: p.multipliesRows,
      steps: p.steps.map((s) => ({
        from: `${s.from.schema}.${s.from.table}`,
        to: `${s.to.schema}.${s.to.table}`,
        direction: s.direction,
        fromColumns: s.fromColumns,
        toColumns: s.toColumns,
        constraint: s.relationship.name,
      })),
      sql: buildJoinSql(p),
    })),
  };
}
export { findPaths };

// ----------------------------------------------------------------------- diff

const MAX_PER_TABLE = 50;

export function shapeDiff(diff: SchemaDiff) {
  const list = <T extends { name: string; status: string; changes?: unknown }>(items: T[]) =>
    items.slice(0, MAX_PER_TABLE).map((i) => ({
      name: i.name,
      status: i.status,
      ...(i.changes ? { changes: i.changes } : {}),
    }));
  return {
    identical: diff.isEmpty,
    summary: {
      schemas: diff.summary.schemas,
      tables: diff.summary.tables,
      columns: diff.summary.columns,
      constraints: diff.summary.constraints,
      indexes: diff.summary.indexes,
      relationships: diff.summary.relationships,
    },
    schemasAdded: diff.schemasAdded.slice(0, MAX_LISTED),
    schemasRemoved: diff.schemasRemoved.slice(0, MAX_LISTED),
    tables: diff.tables.slice(0, MAX_LISTED).map((t) => ({
      table: `${t.schema}.${t.name}`,
      status: t.status,
      ...(t.table.length > 0 ? { tableChanges: t.table } : {}),
      columns: list(t.columns),
      constraints: list(t.constraints),
      indexes: list(t.indexes),
      relationships: list(t.relationships),
    })),
    truncated: diff.tables.length > MAX_LISTED,
    note: OBJECTS_NOT_COMPARED,
  };
}

// ------------------------------------------------------------------ migration

export function shapeMigration(
  plan: MigrationPlan,
  suggestions: readonly RenameSuggestion[],
  confirmed: readonly string[],
) {
  let budget = MAX_SCRIPT_CHARS;
  let omitted = 0;
  const steps = plan.steps.map((s) => {
    const size = s.up.length + (s.down?.length ?? 0);
    const withSql = size <= budget;
    if (withSql) budget -= size;
    else omitted += 1;
    return {
      id: s.id,
      kind: s.kind,
      note: s.note,
      risk: s.risk,
      destructive: s.risk.includes("destructive"),
      reversibility: s.reversibility,
      transactional: s.transactional,
      dependsOn: s.dependsOn,
      ...(withSql ? { up: s.up, down: s.down } : {}),
    };
  });
  const risks: Record<string, number> = {};
  for (const s of plan.steps) for (const r of s.risk) risks[r] = (risks[r] ?? 0) + 1;
  return {
    steps,
    stepCount: plan.steps.length,
    risks,
    reversibility: plan.reversibility,
    sqlOmittedFor: omitted,
    notCompared: [...plan.notCompared, OBJECTS_NOT_COMPARED],
    warnings: plan.warnings,
    renameSuggestions: suggestions.map((s) => ({
      id: s.id,
      kind: s.kind,
      table: s.table,
      from: s.oldName,
      to: s.newName,
      confidence: s.confidence,
      evidence: s.evidence,
      applied: confirmed.includes(s.id),
    })),
    instructions:
      "This is text. It was not run and DataCanvas never runs it. A destructive step loses data; do not suggest running it without saying so. Hand the SQL to the person.",
  };
}

// ----------------------------------------------------------------- prompts

/** The text a person typed for a prompt argument: control characters out, bounded. */
const clean = (value: string | undefined, max = 2000): string =>
  // eslint-disable-next-line no-control-regex -- the point is to remove control characters
  (value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").slice(0, max);

export interface InsightPrompt {
  name: string;
  title: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
  /** Needs the data level (listed only while a connection is shared at it). */
  data: boolean;
  text(args: Record<string, string>): string;
}

const connection = {
  name: "connection",
  description: "The id of a shared connection (list_connections).",
  required: true,
};

export const PROMPTS: readonly InsightPrompt[] = [
  {
    name: "find_tables_without_keys",
    title: "Find tables without a primary key",
    description: "Lists the tables that have no primary key, and what to do about each.",
    arguments: [connection],
    data: false,
    text: (a) =>
      `Use get_health on connection ${clean(a["connection"], 64)} and list the tables with the check "no_primary_key". For each, call describe_table to see its columns and unique constraints, and say which column or columns could be the key and why. Do not run anything; suggest the ALTER TABLE statements as text for the person to review.`,
  },
  {
    name: "review_schema_health",
    title: "Review the health of the schema",
    description: "Runs the health checks and explains what matters most.",
    arguments: [connection],
    data: false,
    text: (a) =>
      `Call get_health for connection ${clean(a["connection"], 64)}. Group the findings by how much they matter (missing keys and unindexed foreign keys on big tables first), explain each group in plain words, and give the suggested SQL as text. Say plainly what the checks cannot know (for example, an index that is unused in the counters may be needed by a monthly job).`,
  },
  {
    name: "explain_schema",
    title: "Explain the schema",
    description: "Explains what the database is for, from its tables and relationships.",
    arguments: [
      connection,
      { name: "schema", description: "Only this schema (optional).", required: false },
    ],
    data: false,
    text: (a) =>
      `Read the resource datacanvas://connection/${clean(a["connection"], 64)}/schema (or call list_tables and describe_table) ${a["schema"] ? `for the schema ${clean(a["schema"], 100)} ` : ""}and explain in plain words what this database is for: the main entities, how they relate, and anything that looks unusual. Do not guess at data you have not read.`,
  },
  {
    name: "how_are_tables_related",
    title: "How are two tables related",
    description: "Finds the foreign-key route between two tables and writes the join.",
    arguments: [
      connection,
      { name: "from", description: "The first table, as schema.table.", required: true },
      { name: "to", description: "The second table, as schema.table.", required: true },
    ],
    data: false,
    text: (a) =>
      `Call find_path on connection ${clean(a["connection"], 64)} from ${clean(a["from"], 200)} to ${clean(a["to"], 200)}. Explain each join, say whether the join multiplies rows, and show the SQL.`,
  },
  {
    name: "review_migration",
    title: "Review a migration between two databases",
    description:
      "Writes the migration from one shared connection to another and reviews its risks. Nothing is run.",
    arguments: [
      { name: "from", description: "The connection that is to change (its id).", required: true },
      { name: "to", description: "The connection it should look like (its id).", required: true },
    ],
    data: false,
    text: (a) =>
      `Call generate_migration with from ${clean(a["from"], 64)} and to ${clean(a["to"], 64)}. Read the risks and warnings of every step; explain the destructive steps and anything that locks a table or may fail on existing rows; check the rename suggestions and say which look right. If the data level is shared for the "from" connection, call check_migration_against_data with the same arguments and say which steps would fail on the data. You never run the SQL: hand it to the person and say what to check first.`,
  },
  {
    name: "tune_query",
    title: "Tune a query",
    description: "Explains the plan of a statement and suggests what to change.",
    arguments: [
      connection,
      { name: "sql", description: "The statement (one SELECT).", required: true },
    ],
    data: true,
    text: (a) =>
      `Call explain_query on connection ${clean(a["connection"], 64)} for this statement, without ANALYZE:\n\n${clean(a["sql"], 5000)}\n\nRead the plan, say where the cost is and why, and suggest changes (an index, a rewrite) as text. Use describe_table for the keys and indexes of the tables involved.`,
  },
];

// ---------------------------------------------------------------- resources

export const schemaUri = (id: string): string => `datacanvas://connection/${id}/schema`;
export const diagramUri = (id: string): string => `datacanvas://connection/${id}/diagram`;
