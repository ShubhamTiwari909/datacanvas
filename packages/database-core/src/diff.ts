/**
 * Compare two database structures: what was added, removed or changed between
 * a "before" and an "after". Pure functions over plain values, so it works the
 * same for a snapshot against the live database, two snapshots, or two
 * different databases.
 *
 * What is compared, and how things are matched:
 *  - schemas and tables by name (`schema.table`). There is NO rename detection:
 *    a renamed table or column shows as one removed and one added;
 *  - columns by name. Their position is ignored (dropping an early column moves
 *    the others, which is not a change to them);
 *  - constraints (primary key, unique, check) and indexes by name. Foreign keys
 *    are compared once, through the relationships (which carry more detail),
 *    not a second time as constraints;
 *  - relationships by (source table, constraint name);
 *  - objects (views, types, sequences, functions, triggers, extensions,
 *    policies, tables with row security) by what identifies each kind: a
 *    function by schema, name AND argument list (overloads are separate
 *    functions), a trigger or policy by its table and name. If either side
 *    never recorded objects (an older snapshot), they are not compared at all,
 *    which is not the same as there being none: it must not report every function as new.
 * Names are matched exactly, so two databases whose constraints were named
 * automatically in a different order can differ in names only.
 *
 * A changed item lists exactly which fields changed, as readable text, so a
 * screen or a report never has to know the shape of each kind of item.
 */
import type {
  ColumnInfo,
  ConstraintInfo,
  DatabaseObjects,
  ExtensionInfo,
  FunctionInfo,
  IndexInfo,
  ObjectKind,
  PolicyInfo,
  RelationshipInfo,
  RowSecurityInfo,
  SequenceInfo,
  TriggerInfo,
  TypeInfo,
  ViewInfo,
} from "./models.js";
import { OBJECT_KINDS } from "./models.js";
import {
  displayName,
  extensionKey,
  functionKey,
  policyKey,
  rowSecurityKey,
  sequenceKey,
  triggerKey,
  typeKey,
  viewKey,
} from "./objects.js";
import { compareText, type DatabaseStructure, type StructureTable } from "./structure.js";

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

export type Item<T> =
  | { status: "added"; after: T }
  | { status: "removed"; before: T }
  | { status: "changed"; before: T; after: T; changes: FieldChange[] };

export type NamedItem<T> = { name: string } & Item<T>;

export interface TableDiff {
  schema: string;
  name: string;
  status: "added" | "removed" | "changed";
  /** The whole table: set for removed (and changed) tables. */
  before: StructureTable | null;
  /** The whole table: set for added (and changed) tables. */
  after: StructureTable | null;
  /** Changes to the table itself (its kind or comment). */
  table: FieldChange[];
  /** The details below are only filled for a CHANGED table; an added or removed table is described by `before` / `after`. */
  columns: NamedItem<ColumnInfo>[];
  constraints: NamedItem<ConstraintInfo>[];
  indexes: NamedItem<IndexInfo>[];
  relationships: NamedItem<RelationshipInfo>[];
}

export interface Counts {
  added: number;
  removed: number;
  changed: number;
}

/** Added, removed and changed objects, one list per kind. */
export type ObjectDiffs = { [K in ObjectKind]: NamedItem<DatabaseObjects[K][number]>[] };

export interface DiffSummary {
  schemas: Counts;
  tables: Counts;
  columns: Counts;
  constraints: Counts;
  indexes: Counts;
  relationships: Counts;
  /** Per kind of object; all zero when `SchemaDiff.objects` is null. */
  objects: { [K in ObjectKind]: Counts };
}

export interface SchemaDiff {
  schemasAdded: string[];
  schemasRemoved: string[];
  tables: TableDiff[];
  /**
   * Differences in views, types, sequences, functions, triggers, extensions and
   * policies. `null` when they were not compared because one side never
   * recorded them (see the top of this file).
   */
  objects: ObjectDiffs | null;
  summary: DiffSummary;
  /** True when the two structures are the same as far as DataCanvas compares. */
  isEmpty: boolean;
}

// ----------------------------------------------------------------- values ---

/** Show a field value as text: arrays joined, booleans as words, "no value" as "(none)". */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(none)";
  if (Array.isArray(value)) return value.length === 0 ? "(none)" : value.join(", ");
  return String(value);
}

type Fields<T> = Record<string, (item: T) => unknown>;

const COLUMN_FIELDS: Fields<ColumnInfo> = {
  type: (c) => c.dataType,
  nullable: (c) => c.nullable,
  default: (c) => c.defaultValue,
  comment: (c) => c.comment,
};
const CONSTRAINT_FIELDS: Fields<ConstraintInfo> = {
  kind: (c) => c.kind,
  columns: (c) => c.columns,
  definition: (c) => c.definition,
};
const INDEX_FIELDS: Fields<IndexInfo> = {
  columns: (i) => i.columns,
  unique: (i) => i.unique,
  primary: (i) => i.primary,
  method: (i) => i.method,
  definition: (i) => i.definition,
};
const RELATIONSHIP_FIELDS: Fields<RelationshipInfo> = {
  "source columns": (r) => r.source.columns,
  target: (r) => `${r.target.schema}.${r.target.table}`,
  "target columns": (r) => r.target.columns,
  cardinality: (r) => r.cardinality,
  "on delete": (r) => r.onDelete,
  "on update": (r) => r.onUpdate,
};
const TABLE_FIELDS: Fields<StructureTable> = {
  kind: (t) => t.kind,
  comment: (t) => t.comment,
};

const refList = (refs: readonly { schema: string; name: string }[]): string[] =>
  refs.map((r) => `${r.schema}.${r.name}`);

const VIEW_FIELDS: Fields<ViewInfo> = {
  materialized: (v) => v.materialized,
  "depends on": (v) => refList(v.dependsOn),
  comment: (v) => v.comment,
  definition: (v) => v.definition,
};
const TYPE_FIELDS: Fields<TypeInfo> = {
  kind: (t) => t.kind,
  values: (t) => t.values,
  attributes: (t) => t.attributes.map((a) => `${a.name} ${a.dataType}`),
  "base type": (t) => t.baseType,
  default: (t) => t.defaultValue,
  constraints: (t) => t.constraints,
  comment: (t) => t.comment,
};
const SEQUENCE_FIELDS: Fields<SequenceInfo> = {
  type: (s) => s.dataType,
  start: (s) => s.start,
  increment: (s) => s.increment,
  minimum: (s) => s.min,
  maximum: (s) => s.max,
  cache: (s) => s.cache,
  cycle: (s) => s.cycle,
  "owned by": (s) =>
    s.ownedBy ? `${s.ownedBy.schema}.${s.ownedBy.table}.${s.ownedBy.column}` : null,
};
const FUNCTION_FIELDS: Fields<FunctionInfo> = {
  kind: (f) => f.kind,
  returns: (f) => f.returns,
  language: (f) => f.language,
  volatility: (f) => f.volatility,
  "security definer": (f) => f.securityDefiner,
  comment: (f) => f.comment,
  definition: (f) => f.definition,
};
const TRIGGER_FIELDS: Fields<TriggerInfo> = {
  timing: (t) => t.timing,
  events: (t) => t.events,
  level: (t) => t.level,
  function: (t) => t.function,
  state: (t) => t.state,
  definition: (t) => t.definition,
};
const EXTENSION_FIELDS: Fields<ExtensionInfo> = {
  version: (e) => e.version,
  schema: (e) => e.schema,
  comment: (e) => e.comment,
};
const POLICY_FIELDS: Fields<PolicyInfo> = {
  command: (p) => p.command,
  permissive: (p) => p.permissive,
  roles: (p) => p.roles,
  using: (p) => p.using,
  "with check": (p) => p.withCheck,
};
const ROW_SECURITY_FIELDS: Fields<RowSecurityInfo> = { forced: (r) => r.forced };

function diffObjects(before: DatabaseObjects, after: DatabaseObjects): ObjectDiffs {
  return {
    views: diffByKey(before.views, after.views, viewKey, displayName.views, VIEW_FIELDS),
    types: diffByKey(before.types, after.types, typeKey, displayName.types, TYPE_FIELDS),
    sequences: diffByKey(
      before.sequences,
      after.sequences,
      sequenceKey,
      displayName.sequences,
      SEQUENCE_FIELDS,
    ),
    functions: diffByKey(
      before.functions,
      after.functions,
      functionKey,
      displayName.functions,
      FUNCTION_FIELDS,
    ),
    triggers: diffByKey(
      before.triggers,
      after.triggers,
      triggerKey,
      displayName.triggers,
      TRIGGER_FIELDS,
    ),
    extensions: diffByKey(
      before.extensions,
      after.extensions,
      extensionKey,
      displayName.extensions,
      EXTENSION_FIELDS,
    ),
    policies: diffByKey(
      before.policies,
      after.policies,
      policyKey,
      displayName.policies,
      POLICY_FIELDS,
    ),
    rowSecurity: diffByKey(
      before.rowSecurity,
      after.rowSecurity,
      rowSecurityKey,
      displayName.rowSecurity,
      ROW_SECURITY_FIELDS,
    ),
  };
}

const ZERO: Counts = { added: 0, removed: 0, changed: 0 };

function changesBetween<T>(fields: Fields<T>, before: T, after: T): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, get] of Object.entries(fields)) {
    const a = formatValue(get(before));
    const b = formatValue(get(after));
    if (a !== b) changes.push({ field, before: a, after: b });
  }
  return changes;
}

/** Added, removed and changed items between two lists, matched by `key`, sorted by name. */
function diffByKey<T>(
  before: readonly T[],
  after: readonly T[],
  key: (item: T) => string,
  nameOf: (item: T) => string,
  fields: Fields<T>,
): NamedItem<T>[] {
  const was = new Map(before.map((item) => [key(item), item]));
  const now = new Map(after.map((item) => [key(item), item]));
  const result: NamedItem<T>[] = [];
  for (const [k, item] of was) {
    const next = now.get(k);
    if (next === undefined) {
      result.push({ name: nameOf(item), status: "removed", before: item });
    } else {
      const changes = changesBetween(fields, item, next);
      if (changes.length > 0) {
        result.push({ name: nameOf(item), status: "changed", before: item, after: next, changes });
      }
    }
  }
  for (const [k, item] of now) {
    if (!was.has(k)) result.push({ name: nameOf(item), status: "added", after: item });
  }
  return result.sort((a, b) => compareText(a.name, b.name));
}

const tableKey = (schema: string, name: string): string => JSON.stringify([schema, name]);

const count = (items: readonly { status: string }[]): Counts => ({
  added: items.filter((i) => i.status === "added").length,
  removed: items.filter((i) => i.status === "removed").length,
  changed: items.filter((i) => i.status === "changed").length,
});

const addCounts = (a: Counts, b: Counts): Counts => ({
  added: a.added + b.added,
  removed: a.removed + b.removed,
  changed: a.changed + b.changed,
});

// ------------------------------------------------------------------- diff ---

export function diffStructures(before: DatabaseStructure, after: DatabaseStructure): SchemaDiff {
  const schemasAdded = after.schemas.filter((s) => !before.schemas.includes(s));
  const schemasRemoved = before.schemas.filter((s) => !after.schemas.includes(s));

  const beforeTables = new Map(before.tables.map((t) => [tableKey(t.schema, t.name), t]));
  const afterTables = new Map(after.tables.map((t) => [tableKey(t.schema, t.name), t]));

  // Foreign keys, grouped by the table that holds them.
  const group = (relationships: readonly RelationshipInfo[]) => {
    const map = new Map<string, RelationshipInfo[]>();
    for (const r of relationships) {
      const k = tableKey(r.source.schema, r.source.table);
      map.set(k, [...(map.get(k) ?? []), r]);
    }
    return map;
  };
  const beforeRels = group(before.relationships);
  const afterRels = group(after.relationships);

  const tables: TableDiff[] = [];
  const empty = { table: [], columns: [], constraints: [], indexes: [], relationships: [] };

  for (const [key, table] of beforeTables) {
    const next = afterTables.get(key);
    if (next === undefined) {
      tables.push({
        schema: table.schema,
        name: table.name,
        status: "removed",
        before: table,
        after: null,
        ...empty,
      });
      continue;
    }
    const detail = {
      table: changesBetween(TABLE_FIELDS, table, next),
      columns: diffByKey(
        table.columns,
        next.columns,
        (c) => c.name,
        (c) => c.name,
        COLUMN_FIELDS,
      ),
      // Foreign keys are compared as relationships, below.
      constraints: diffByKey(
        table.constraints.filter((c) => c.kind !== "foreign_key"),
        next.constraints.filter((c) => c.kind !== "foreign_key"),
        (c) => c.name,
        (c) => c.name,
        CONSTRAINT_FIELDS,
      ),
      indexes: diffByKey(
        table.indexes,
        next.indexes,
        (i) => i.name,
        (i) => i.name,
        INDEX_FIELDS,
      ),
      relationships: diffByKey(
        beforeRels.get(key) ?? [],
        afterRels.get(key) ?? [],
        (r) => r.name,
        (r) => r.name,
        RELATIONSHIP_FIELDS,
      ),
    };
    const changed =
      detail.table.length +
        detail.columns.length +
        detail.constraints.length +
        detail.indexes.length +
        detail.relationships.length >
      0;
    if (changed) {
      tables.push({
        schema: table.schema,
        name: table.name,
        status: "changed",
        before: table,
        after: next,
        ...detail,
      });
    }
  }
  for (const [key, table] of afterTables) {
    if (!beforeTables.has(key)) {
      tables.push({
        schema: table.schema,
        name: table.name,
        status: "added",
        before: null,
        after: table,
        ...empty,
      });
    }
  }
  tables.sort((a, b) => compareText(a.schema, b.schema) || compareText(a.name, b.name));

  const sum = (pick: (t: TableDiff) => { status: string }[]): Counts =>
    tables.map((t) => count(pick(t))).reduce(addCounts, { added: 0, removed: 0, changed: 0 });

  const objects =
    before.objects !== null && after.objects !== null
      ? diffObjects(before.objects, after.objects)
      : null;
  const objectCounts = Object.fromEntries(
    OBJECT_KINDS.map((kind) => [kind, objects === null ? ZERO : count(objects[kind])]),
  ) as DiffSummary["objects"];
  const objectsChanged = objects !== null && OBJECT_KINDS.some((kind) => objects[kind].length > 0);

  const summary: DiffSummary = {
    schemas: { added: schemasAdded.length, removed: schemasRemoved.length, changed: 0 },
    tables: count(tables),
    columns: sum((t) => t.columns),
    constraints: sum((t) => t.constraints),
    indexes: sum((t) => t.indexes),
    relationships: sum((t) => t.relationships),
    objects: objectCounts,
  };

  return {
    schemasAdded,
    schemasRemoved,
    tables,
    objects,
    summary,
    isEmpty:
      schemasAdded.length === 0 &&
      schemasRemoved.length === 0 &&
      tables.length === 0 &&
      !objectsChanged,
  };
}

// --------------------------------------------------------------- markdown ---

/** Wrap text as inline code, whatever it contains (names may include backticks). */
function code(text: string): string {
  const single = text.replace(/\s+/g, " ");
  const longest = Math.max(0, ...(single.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return longest > 0 ? `${fence} ${single} ${fence}` : `${fence}${single}${fence}`;
}

const MAX_VALUE = 120;
const short = (text: string): string =>
  text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}...` : text;

function itemLines<T extends { name?: string }>(label: string, items: NamedItem<T>[]): string[] {
  return items.map((item) => {
    if (item.status === "added") return `- added ${label} ${code(item.name)}`;
    if (item.status === "removed") return `- removed ${label} ${code(item.name)}`;
    const detail = item.changes
      .map((c) => `${c.field}: ${code(short(c.before))} → ${code(short(c.after))}`)
      .join("; ");
    return `- changed ${label} ${code(item.name)}: ${detail}`;
  });
}

const NOT_COMPARED =
  "Views, types, sequences, functions, triggers, extensions and policies were not compared: one side was saved before they were recorded.";

/** What each kind of object is called in a report. */
export const OBJECT_LABELS: { [K in ObjectKind]: { one: string; many: string } } = {
  views: { one: "view", many: "Views" },
  types: { one: "type", many: "Types" },
  sequences: { one: "sequence", many: "Sequences" },
  functions: { one: "function", many: "Functions" },
  triggers: { one: "trigger", many: "Triggers" },
  extensions: { one: "extension", many: "Extensions" },
  policies: { one: "policy", many: "Policies" },
  rowSecurity: { one: "row security setting", many: "Row security" },
};

const row = (label: string, c: Counts): string =>
  `| ${label} | ${c.added} | ${c.removed} | ${c.changed} |`;

/** A Markdown report of the differences, for a review or a ticket. */
export function diffToMarkdown(
  diff: SchemaDiff,
  labels: { before: string; after: string },
): string {
  const lines = [
    "# Structure changes",
    "",
    `Before: ${code(labels.before)}`,
    `After: ${code(labels.after)}`,
    "",
  ];
  if (diff.isEmpty) {
    lines.push(
      "No differences in schemas, tables, columns, constraints, indexes or relationships" +
        (diff.objects === null
          ? "."
          : ", views, types, sequences, functions, triggers, extensions or policies."),
      "",
    );
    if (diff.objects === null) lines.push(NOT_COMPARED, "");
    return lines.join("\n");
  }
  const s = diff.summary;
  lines.push(
    "| | Added | Removed | Changed |",
    "| --- | ---: | ---: | ---: |",
    row("Schemas", s.schemas),
    row("Tables", s.tables),
    row("Columns", s.columns),
    row("Constraints", s.constraints),
    row("Indexes", s.indexes),
    row("Relationships", s.relationships),
    ...(diff.objects === null
      ? []
      : OBJECT_KINDS.filter((kind) => diff.objects![kind].length > 0).map((kind) =>
          row(OBJECT_LABELS[kind].many, s.objects[kind]),
        )),
    "",
  );
  if (diff.objects === null) lines.push(NOT_COMPARED, "");
  if (diff.schemasAdded.length > 0)
    lines.push(`Schemas added: ${diff.schemasAdded.map(code).join(", ")}`, "");
  if (diff.schemasRemoved.length > 0)
    lines.push(`Schemas removed: ${diff.schemasRemoved.map(code).join(", ")}`, "");

  for (const table of diff.tables) {
    const name = code(`${table.schema}.${table.name}`);
    if (table.status === "added") {
      lines.push(`## Added table ${name}`, "", `${table.after?.columns.length ?? 0} columns.`, "");
    } else if (table.status === "removed") {
      lines.push(
        `## Removed table ${name}`,
        "",
        `It had ${table.before?.columns.length ?? 0} columns.`,
        "",
      );
    } else {
      lines.push(`## Changed table ${name}`, "");
      for (const c of table.table) {
        lines.push(`- table ${c.field}: ${code(short(c.before))} → ${code(short(c.after))}`);
      }
      lines.push(
        ...itemLines("column", table.columns),
        ...itemLines("constraint", table.constraints),
        ...itemLines("index", table.indexes),
        ...itemLines("relationship", table.relationships),
        "",
      );
    }
  }
  if (diff.objects !== null) {
    const found = OBJECT_KINDS.filter((kind) => diff.objects![kind].length > 0);
    if (found.length > 0) lines.push("## Objects", "");
    for (const kind of found) {
      lines.push(
        ...itemLines(OBJECT_LABELS[kind].one, diff.objects[kind] as NamedItem<{ name?: string }>[]),
        "",
      );
    }
  }
  return lines.join("\n");
}
