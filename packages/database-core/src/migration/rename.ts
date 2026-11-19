/**
 * Renames, which a person confirms and the planner never assumes
 * (`docs/migration-studio-plan.md`, section 3.3).
 *
 * `suggestRenames(from, to)` looks for a table, column, constraint or index that is gone in one
 * structure and new in the other with the same shape, and offers it as a rename with the evidence.
 * `applyRenames` turns the ones a person confirmed into `ALTER ... RENAME` steps and rewrites the
 * starting structure as PostgreSQL would have it after them, so the rest of the plan sees the
 * renamed thing as the same thing (the data survives) and plans only what really differs. A rename
 * that was not confirmed stays a drop and an add.
 *
 * Names inside definition text (an index on the table, a check on the column) are rewritten by
 * identifier. If the rewrite does not come out the way PostgreSQL prints it, the only cost is an
 * extra drop and add of that constraint or index, never a wrong one.
 */
import type { DdlDetail } from "../ddl.js";
import type { ConstraintInfo, DatabaseObjects, IndexInfo, RelationshipInfo } from "../models.js";
import type { DatabaseStructure, StructureTable } from "../structure.js";
import { SEP, type Draft } from "./draft.js";
import { q, qualified } from "./sql.js";

export type RenameKind = "table" | "column" | "constraint" | "index" | "sequence";
export type RenameConfidence = "high" | "medium" | "low";

export interface RenameSuggestion {
  /** Stable for the same pair of structures: what a person confirms and a plan option names. */
  id: string;
  kind: RenameKind;
  schema: string;
  /** The table's name in the TARGET (for a table rename, its new name). */
  table: string;
  /** The old name and the new name of the table, column, constraint or index. */
  oldName: string;
  newName: string;
  /** For a table rename: the old table name is `oldName`; for the rest `table` is the table as it ends up. */
  confidence: RenameConfidence;
  /** Plain sentences for the screen: why this looks like a rename. */
  evidence: string[];
  /** Other candidates that fit as well (their new names), when the choice is not clear. */
  alternatives: string[];
  /** Suggestions that must be confirmed too (a column of a table that is renamed is named by the new table). */
  requires: string[];
}

export interface AppliedRenames {
  structure: DatabaseStructure;
  /** In the order they run: tables, columns, constraints, indexes. */
  drafts: Draft[];
  applied: string[];
  /** Views whose text was rewritten for the new names: they are made with an explicit column list. */
  rewrittenViews: Set<string>;
  /** Views that read a table with a renamed column: PostgreSQL keeps their old column name, so they must be made again. */
  remakeViews: Set<string>;
  /** The old names of the tables and columns that were renamed. */
  oldNames: string[];
  /** Ids that were asked for and do not apply to these two structures. */
  ignored: string[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const tkey = (schema: string, table: string): string => `${schema}${SEP}${table}`;

// ------------------------------------------------------------- identifiers in text

const RESERVED = new Set(
  "all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp not null offset on only or order placing primary references returning select session_user some symmetric system_user table then to trailing true union unique user using variadic when where window with".split(
    " ",
  ),
);

/** How PostgreSQL prints a name: bare when it can be, quoted when it must be. */
export function printedIdentifier(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name)
    ? name
    : `"${name.replace(/"/g, '""')}"`;
}

/** Does `text` write `name` as an identifier? */
export const writesIdentifier = (text: string, name: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_$"])(?:${spellings(name)})(?![A-Za-z0-9_$"])`).test(text);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ways a name can be written in text PostgreSQL printed. */
const spellings = (name: string): string =>
  /^[a-z_][a-z0-9_$]*$/.test(name)
    ? `"${escapeRegExp(name)}"|${escapeRegExp(name)}`
    : `"${escapeRegExp(name.replace(/"/g, '""'))}"`;

/** Replace a name written as an identifier (not a part of a longer name) and not inside a string. */
export function replaceIdentifier(text: string, oldName: string, newName: string): string {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$"])(?:${spellings(oldName)})(?![A-Za-z0-9_$"])`, "g");
  return text
    .split(/('(?:[^']|'')*')/)
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(pattern, `$1${printedIdentifier(newName)}`),
    )
    .join("");
}

/** `schema.old` written as PostgreSQL prints a table reference, replaced by the new table. */
export function replaceTableReference(
  text: string,
  schema: string,
  oldName: string,
  newName: string,
): string {
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_$"])(?:${spellings(schema)})\\.(?:${spellings(oldName)})(?![A-Za-z0-9_$"])`,
    "g",
  );
  return text.replace(pattern, `$1${printedIdentifier(schema)}.${printedIdentifier(newName)}`);
}

// ---------------------------------------------------------------- transformations

function mapTables(
  s: DatabaseStructure,
  schema: string,
  table: string,
  change: (t: StructureTable) => StructureTable,
): DatabaseStructure {
  return {
    ...s,
    tables: s.tables.map((t) => (t.schema === schema && t.name === table ? change(t) : t)),
  };
}

/** The structure after `ALTER TABLE schema.old RENAME TO new`, as PostgreSQL would read it. */
function withTableRenamed(
  s: DatabaseStructure,
  schema: string,
  oldName: string,
  newName: string,
): DatabaseStructure {
  const text = (value: string | null): string | null =>
    value === null ? null : replaceTableReference(value, schema, oldName, newName);
  const tables = s.tables.map((t) => {
    const same = t.schema === schema && t.name === oldName;
    return {
      ...t,
      name: same ? newName : t.name,
      constraints: t.constraints.map((c) => ({ ...c, definition: text(c.definition) })),
      indexes: t.indexes.map((i) => ({ ...i, definition: text(i.definition) })),
    };
  });
  const end = <T extends { schema: string; table: string }>(e: T): T =>
    e.schema === schema && e.table === oldName ? { ...e, table: newName } : e;
  const relationships: RelationshipInfo[] = s.relationships.map((r) => ({
    ...r,
    source: end(r.source),
    target: end(r.target),
  }));
  const objects: DatabaseObjects | null =
    s.objects === null
      ? null
      : {
          ...s.objects,
          // The text of a view that reads the table is rewritten so it can be run after the rename.
          views: s.objects.views.map((v) => {
            const reads = v.dependsOn.some((d) => d.schema === schema && d.name === oldName);
            return {
              ...v,
              definition: reads ? replaceIdentifier(v.definition, oldName, newName) : v.definition,
              dependsOn: v.dependsOn.map((d) =>
                d.schema === schema && d.name === oldName ? { ...d, name: newName } : d,
              ),
            };
          }),
          sequences: s.objects.sequences.map((x) =>
            x.ownedBy ? { ...x, ownedBy: end(x.ownedBy) } : x,
          ),
          triggers: s.objects.triggers.map(end),
          policies: s.objects.policies.map(end),
          rowSecurity: s.objects.rowSecurity.map(end),
        };
  const ddl: DdlDetail | null =
    s.ddl === null
      ? null
      : {
          ...s.ddl,
          columns: s.ddl.columns.map(end),
          constraints: s.ddl.constraints.map(end),
          tables: s.ddl.tables.map((t) => ({
            ...t,
            name: t.schema === schema && t.name === oldName ? newName : t.name,
            partitionOf: t.partitionOf ? end(t.partitionOf) : null,
            inherits: t.inherits.map(end),
          })),
          comments: s.ddl.comments.map((c) =>
            c.table !== null && c.schema === schema && c.table === oldName
              ? { ...c, table: newName }
              : c,
          ),
        };
  return { ...s, tables, relationships, objects, ddl };
}

/** The structure after `ALTER TABLE ... RENAME COLUMN old TO new`. */
function withColumnRenamed(
  s: DatabaseStructure,
  schema: string,
  table: string,
  oldName: string,
  newName: string,
): DatabaseStructure {
  const rename = (list: string[]): string[] => list.map((c) => (c === oldName ? newName : c));
  const isForeign = (c: ConstraintInfo) => c.kind === "foreign_key";
  const split = (definition: string): [string, string] => {
    const at = definition.indexOf(" REFERENCES ");
    return at < 0 ? [definition, ""] : [definition.slice(0, at), definition.slice(at)];
  };
  const fix = (definition: string | null, where: "source" | "target" | "all"): string | null => {
    if (definition === null) return null;
    if (where === "all") return replaceIdentifier(definition, oldName, newName);
    const [head, tail] = split(definition);
    return where === "source"
      ? replaceIdentifier(head, oldName, newName) + tail
      : head + replaceIdentifier(tail, oldName, newName);
  };
  const tables = s.tables.map((t) => {
    const mine = t.schema === schema && t.name === table;
    const targetsMe = new Set(
      s.relationships
        .filter(
          (r) =>
            r.target.schema === schema &&
            r.target.table === table &&
            r.target.columns.includes(oldName) &&
            r.source.schema === t.schema &&
            r.source.table === t.name,
        )
        .map((r) => r.name),
    );
    const constraints = t.constraints.map((c) => {
      if (mine && !isForeign(c)) {
        return { ...c, columns: rename(c.columns), definition: fix(c.definition, "all") };
      }
      if (mine && isForeign(c)) {
        const aimsAtMe = targetsMe.has(c.name);
        return {
          ...c,
          columns: rename(c.columns),
          definition: fix(fix(c.definition, "source"), aimsAtMe ? "target" : "source"),
        };
      }
      if (isForeign(c) && targetsMe.has(c.name)) {
        return { ...c, definition: fix(c.definition, "target") };
      }
      return c;
    });
    if (!mine) return { ...t, constraints };
    const indexes = t.indexes.map((i): IndexInfo => {
      const tail = (d: string | null): string | null => {
        if (d === null) return null;
        const at = d.indexOf(" USING ");
        return at < 0 ? d : d.slice(0, at) + (fix(d.slice(at), "all") ?? "");
      };
      return {
        ...i,
        columns: i.columns.map((c) =>
          c === oldName ? newName : replaceIdentifier(c, oldName, newName),
        ),
        definition: tail(i.definition),
      };
    });
    const generated = new Set(
      (s.ddl?.columns ?? [])
        .filter((c) => c.schema === schema && c.table === table && c.generated)
        .map((c) => c.column),
    );
    return {
      ...t,
      columns: t.columns.map((c) => ({
        ...c,
        name: c.name === oldName ? newName : c.name,
        defaultValue:
          c.defaultValue !== null && generated.has(c.name)
            ? replaceIdentifier(c.defaultValue, oldName, newName)
            : c.defaultValue,
      })),
      constraints,
      indexes,
    };
  });
  const objects: DatabaseObjects | null =
    s.objects === null
      ? null
      : {
          ...s.objects,
          views: s.objects.views.map((v) =>
            v.dependsOn.some((d) => d.schema === schema && d.name === table)
              ? { ...v, definition: replaceIdentifier(v.definition, oldName, newName) }
              : v,
          ),
          // A sequence follows the column that owns it.
          sequences: s.objects.sequences.map((x) =>
            x.ownedBy &&
            x.ownedBy.schema === schema &&
            x.ownedBy.table === table &&
            x.ownedBy.column === oldName
              ? { ...x, ownedBy: { ...x.ownedBy, column: newName } }
              : x,
          ),
        };
  const relationships = s.relationships.map((r) => ({
    ...r,
    source:
      r.source.schema === schema && r.source.table === table
        ? { ...r.source, columns: rename(r.source.columns) }
        : r.source,
    target:
      r.target.schema === schema && r.target.table === table
        ? { ...r.target, columns: rename(r.target.columns) }
        : r.target,
  }));
  const ddl: DdlDetail | null =
    s.ddl === null
      ? null
      : {
          ...s.ddl,
          columns: s.ddl.columns.map((c) =>
            c.schema === schema && c.table === table && c.column === oldName
              ? { ...c, column: newName }
              : c,
          ),
        };
  return { ...s, tables, relationships, objects, ddl };
}

/** After `ALTER TABLE ... RENAME CONSTRAINT old TO new` (which renames the index behind a key too). */
function withConstraintRenamed(
  s: DatabaseStructure,
  schema: string,
  table: string,
  oldName: string,
  newName: string,
): DatabaseStructure {
  const named = (c: { name: string }) => (c.name === oldName ? newName : c.name);
  const next = mapTables(s, schema, table, (t) => {
    const kind = t.constraints.find((c) => c.name === oldName)?.kind;
    return {
      ...t,
      constraints: t.constraints.map((c) => (c.name === oldName ? { ...c, name: newName } : c)),
      indexes:
        kind === undefined || kind === "check" || kind === "foreign_key"
          ? t.indexes
          : t.indexes.map((i) => (i.name === oldName ? renamedIndex(i, newName) : i)),
    };
  });
  return {
    ...next,
    relationships: next.relationships.map((r) =>
      r.source.schema === schema && r.source.table === table && r.name === oldName
        ? { ...r, name: newName }
        : r,
    ),
    ddl:
      next.ddl === null
        ? null
        : {
            ...next.ddl,
            constraints: next.ddl.constraints.map((c) =>
              c.schema === schema && c.table === table ? { ...c, name: named(c) } : c,
            ),
            comments: next.ddl.comments.map((c) =>
              c.schema === schema &&
              c.table === table &&
              (c.target === "constraint" || c.target === "index") &&
              c.name === oldName
                ? { ...c, name: newName }
                : c,
            ),
          },
  };
}

function renamedIndex(i: IndexInfo, newName: string): IndexInfo {
  const definition =
    i.definition === null
      ? null
      : i.definition.replace(
          /^(CREATE (?:UNIQUE )?INDEX )(?:"(?:[^"]|"")*"|\S+)( ON )/,
          (_all, head: string, on: string) => `${head}${printedIdentifier(newName)}${on}`,
        );
  return { ...i, name: newName, definition };
}

function withIndexRenamed(
  s: DatabaseStructure,
  schema: string,
  table: string,
  oldName: string,
  newName: string,
): DatabaseStructure {
  const next = mapTables(s, schema, table, (t) => ({
    ...t,
    indexes: t.indexes.map((i) => (i.name === oldName ? renamedIndex(i, newName) : i)),
  }));
  return next.ddl === null
    ? next
    : {
        ...next,
        ddl: {
          ...next.ddl,
          comments: next.ddl.comments.map((c) =>
            c.target === "index" && c.schema === schema && c.table === table && c.name === oldName
              ? { ...c, name: newName }
              : c,
          ),
        },
      };
}

/** After `ALTER SEQUENCE schema.old RENAME TO new`: the defaults that call `nextval` on it print the new name. */
function withSequenceRenamed(
  s: DatabaseStructure,
  schema: string,
  oldName: string,
  newName: string,
): DatabaseStructure {
  const fixDefault = (value: string | null): string | null =>
    value === null
      ? null
      : value.replace(/nextval\('((?:[^']|'')*)'::regclass\)/g, (all, inner: string) => {
          const text = inner.replace(/''/g, "'");
          const changed = replaceIdentifier(text, oldName, newName);
          return changed === text ? all : `nextval('${changed.replace(/'/g, "''")}'::regclass)`;
        });
  return {
    ...s,
    tables: s.tables.map((t) => ({
      ...t,
      columns: t.columns.map((c) => ({ ...c, defaultValue: fixDefault(c.defaultValue) })),
    })),
    objects:
      s.objects === null
        ? null
        : {
            ...s.objects,
            sequences: s.objects.sequences.map((x) =>
              x.schema === schema && x.name === oldName ? { ...x, name: newName } : x,
            ),
          },
    ddl:
      s.ddl === null
        ? null
        : {
            ...s.ddl,
            comments: s.ddl.comments.map((c) =>
              c.target === "sequence" && c.schema === schema && c.name === oldName
                ? { ...c, name: newName }
                : c,
            ),
          },
  };
}

// ------------------------------------------------------------------ suggestions

const idOf = (kind: RenameKind, schema: string, table: string, a: string, b: string): string =>
  `${kind}:${JSON.stringify([schema, table, a, b])}`;

function tablesOf(s: DatabaseStructure): Map<string, StructureTable> {
  return new Map(
    s.tables.filter((t) => t.kind === "table").map((t) => [tkey(t.schema, t.name), t]),
  );
}

const sortedColumns = (t: StructureTable) =>
  [...t.columns].sort((x, y) => x.ordinalPosition - y.ordinalPosition);

interface Candidate {
  from: string;
  to: string;
  score: number;
}

/** Pair each old name with its best new name, once each; ties by name. */
function assign(candidates: Candidate[]): { chosen: Candidate; alternatives: string[] }[] {
  const sorted = [...candidates].sort(
    (a, b) => b.score - a.score || compareText(a.from, b.from) || compareText(a.to, b.to),
  );
  const usedFrom = new Set<string>();
  const usedTo = new Set<string>();
  const out: { chosen: Candidate; alternatives: string[] }[] = [];
  for (const c of sorted) {
    if (usedFrom.has(c.from) || usedTo.has(c.to)) continue;
    usedFrom.add(c.from);
    usedTo.add(c.to);
    const alternatives = sorted
      .filter((o) => o !== c && o.score === c.score && (o.from === c.from || o.to === c.to))
      .map((o) => (o.from === c.from ? o.to : o.from));
    out.push({ chosen: c, alternatives: [...new Set(alternatives)].sort(compareText) });
  }
  return out;
}

function suggestTables(from: DatabaseStructure, to: DatabaseStructure): RenameSuggestion[] {
  const a = tablesOf(from);
  const b = tablesOf(to);
  const gone = [...a.values()].filter((t) => !b.has(tkey(t.schema, t.name)));
  const added = [...b.values()].filter((t) => !a.has(tkey(t.schema, t.name)));
  const out: RenameSuggestion[] = [];
  const bySchema = new Set(gone.map((t) => t.schema));
  for (const schema of [...bySchema].sort(compareText)) {
    const candidates: (Candidate & { names: number; count: number })[] = [];
    for (const d of gone.filter((t) => t.schema === schema)) {
      for (const c of added.filter((t) => t.schema === schema)) {
        const x = sortedColumns(d);
        const y = sortedColumns(c);
        if (x.length === 0 || x.length !== y.length) continue;
        if (!x.every((col, i) => col.dataType === y[i]!.dataType)) continue;
        const same = x.filter((col, i) => col.name === y[i]!.name).length;
        if (same * 2 < x.length) continue;
        candidates.push({
          from: d.name,
          to: c.name,
          score: same / x.length,
          names: same,
          count: x.length,
        });
      }
    }
    for (const { chosen, alternatives } of assign(candidates)) {
      const meta = candidates.find((c) => c.from === chosen.from && c.to === chosen.to)!;
      const exact = meta.names === meta.count;
      out.push({
        id: idOf("table", schema, chosen.to, chosen.from, chosen.to),
        kind: "table",
        schema,
        table: chosen.to,
        oldName: chosen.from,
        newName: chosen.to,
        confidence: alternatives.length > 0 ? "low" : exact ? "high" : "medium",
        evidence: [
          `${chosen.from} is gone and ${chosen.to} is new, in the same schema.`,
          exact
            ? `Both have the same ${meta.count} column${meta.count === 1 ? "" : "s"}, with the same names and types.`
            : `Both have ${meta.count} columns with the same types in the same order; ${meta.names} have the same name.`,
          ...(alternatives.length > 0
            ? [`Another table fits as well: ${alternatives.join(", ")}. Check which one it is.`]
            : []),
        ],
        alternatives,
        requires: [],
      });
    }
  }
  return out.sort((x, y) => compareText(x.id, y.id));
}

function suggestColumns(
  hyp: DatabaseStructure,
  to: DatabaseStructure,
  tableIds: Map<string, string>,
): RenameSuggestion[] {
  const a = tablesOf(hyp);
  const b = tablesOf(to);
  const out: RenameSuggestion[] = [];
  for (const [key, now] of [...b].sort(([x], [y]) => compareText(x, y))) {
    const was = a.get(key);
    if (!was) continue;
    const beforeNames = new Set(was.columns.map((c) => c.name));
    const afterNames = new Set(now.columns.map((c) => c.name));
    const gone = was.columns.filter((c) => !afterNames.has(c.name));
    const added = now.columns.filter((c) => !beforeNames.has(c.name));
    const candidates: (Candidate & { samePlace: boolean; onlyOne: boolean; type: string })[] = [];
    for (const d of gone) {
      for (const c of added) {
        if (d.dataType !== c.dataType) continue;
        const sameType = (list: typeof gone) =>
          list.filter((x) => x.dataType === d.dataType).length;
        const onlyOne = sameType(gone) === 1 && sameType(added) === 1;
        const samePlace = d.ordinalPosition === c.ordinalPosition;
        if (!samePlace && !onlyOne) continue;
        candidates.push({
          from: d.name,
          to: c.name,
          score: samePlace ? 2 : 1,
          samePlace,
          onlyOne,
          type: d.dataType,
        });
      }
    }
    for (const { chosen, alternatives } of assign(candidates)) {
      const meta = candidates.find((c) => c.from === chosen.from && c.to === chosen.to)!;
      out.push({
        id: idOf("column", now.schema, now.name, chosen.from, chosen.to),
        kind: "column",
        schema: now.schema,
        table: now.name,
        oldName: chosen.from,
        newName: chosen.to,
        confidence: alternatives.length > 0 ? "low" : meta.samePlace ? "high" : "medium",
        evidence: [
          `${chosen.from} is gone from ${now.name} and ${chosen.to} is new.`,
          meta.samePlace
            ? `Both are ${meta.type}, in position ${was.columns.find((c) => c.name === chosen.from)!.ordinalPosition}.`
            : `Both are ${meta.type}, and no other ${meta.type} column was added or removed.`,
          ...(alternatives.length > 0
            ? [`Another column fits as well: ${alternatives.join(", ")}.`]
            : []),
        ],
        alternatives,
        requires: tableIds.has(key) ? [tableIds.get(key)!] : [],
      });
    }
  }
  return out.sort((x, y) => compareText(x.id, y.id));
}

const indexTail = (i: IndexInfo): string => {
  const at = (i.definition ?? "").indexOf(" USING ");
  return at < 0 ? (i.definition ?? "") : (i.definition ?? "").slice(at);
};

function suggestNamed(
  hyp: DatabaseStructure,
  to: DatabaseStructure,
  touching: Map<string, string[]>,
): RenameSuggestion[] {
  const a = tablesOf(hyp);
  const b = tablesOf(to);
  const out: RenameSuggestion[] = [];
  for (const [key, now] of [...b].sort(([x], [y]) => compareText(x, y))) {
    const was = a.get(key);
    if (!was) continue;
    const requires = touching.get(key) ?? [];
    const beforeC = new Set(was.constraints.map((c) => c.name));
    const afterC = new Set(now.constraints.map((c) => c.name));
    const gone = was.constraints.filter((c) => !afterC.has(c.name));
    const added = now.constraints.filter((c) => !beforeC.has(c.name));
    const cands: Candidate[] = [];
    for (const d of gone) {
      for (const c of added) {
        if (d.kind === c.kind && d.definition !== null && d.definition === c.definition) {
          cands.push({ from: d.name, to: c.name, score: 1 });
        }
      }
    }
    for (const { chosen, alternatives } of assign(cands)) {
      const def = gone.find((c) => c.name === chosen.from)!.definition;
      out.push({
        id: idOf("constraint", now.schema, now.name, chosen.from, chosen.to),
        kind: "constraint",
        schema: now.schema,
        table: now.name,
        oldName: chosen.from,
        newName: chosen.to,
        confidence: alternatives.length > 0 ? "low" : "high",
        evidence: [
          `${chosen.from} is gone from ${now.name} and ${chosen.to} is new, with the same definition: ${def ?? ""}.`,
        ],
        alternatives,
        requires,
      });
    }
    const beforeI = new Set(was.indexes.map((i) => i.name));
    const afterI = new Set(now.indexes.map((i) => i.name));
    const backed = (t: StructureTable, i: IndexInfo) =>
      i.primary || t.constraints.some((c) => c.name === i.name && c.kind !== "check");
    const goneI = was.indexes.filter((i) => !afterI.has(i.name) && !backed(was, i));
    const addedI = now.indexes.filter((i) => !beforeI.has(i.name) && !backed(now, i));
    const icands: Candidate[] = [];
    for (const d of goneI) {
      for (const c of addedI) {
        if (d.unique === c.unique && d.method === c.method && indexTail(d) === indexTail(c)) {
          icands.push({ from: d.name, to: c.name, score: 1 });
        }
      }
    }
    for (const { chosen, alternatives } of assign(icands)) {
      out.push({
        id: idOf("index", now.schema, now.name, chosen.from, chosen.to),
        kind: "index",
        schema: now.schema,
        table: now.name,
        oldName: chosen.from,
        newName: chosen.to,
        confidence: alternatives.length > 0 ? "low" : "high",
        evidence: [
          `${chosen.from} is gone from ${now.name} and ${chosen.to} is new, on the same columns with the same definition.`,
        ],
        alternatives,
        requires,
      });
    }
  }
  return out.sort((x, y) => compareText(x.id, y.id));
}

/** Sequences that are gone and new with the same settings and the same owner: PostgreSQL keeps a sequence's name when its column is renamed. */
function suggestSequences(
  hyp: DatabaseStructure,
  to: DatabaseStructure,
  touching: Map<string, string[]>,
): RenameSuggestion[] {
  if (hyp.objects === null || to.objects === null) return [];
  // Identity columns' sequences too: PostgreSQL keeps their old name when the column is renamed.
  const mine = (s: DatabaseStructure) => s.objects!.sequences;
  const before = mine(hyp);
  const after = mine(to);
  const key = (x: { schema: string; name: string }) => tkey(x.schema, x.name);
  const had = new Set(before.map(key));
  const has = new Set(after.map(key));
  const shape = (x: (typeof before)[number]) =>
    JSON.stringify([
      x.schema,
      x.dataType,
      x.start,
      x.increment,
      x.min,
      x.max,
      x.cache,
      x.cycle,
      x.ownedBy,
    ]);
  const out: RenameSuggestion[] = [];
  const gone = before.filter((x) => !has.has(key(x)) && x.ownedBy !== null);
  const added = after.filter((x) => !had.has(key(x)) && x.ownedBy !== null);
  const cands: Candidate[] = [];
  for (const d of gone) {
    for (const c of added) {
      if (shape(d) === shape(c)) cands.push({ from: d.name, to: c.name, score: 1 });
    }
  }
  for (const { chosen, alternatives } of assign(cands)) {
    const seq = gone.find((x) => x.name === chosen.from)!;
    const owner = seq.ownedBy!;
    out.push({
      id: idOf("sequence", seq.schema, owner.table, chosen.from, chosen.to),
      kind: "sequence",
      schema: seq.schema,
      table: owner.table,
      oldName: chosen.from,
      newName: chosen.to,
      confidence: alternatives.length > 0 ? "low" : "high",
      evidence: [
        `The sequence ${chosen.from} is gone and ${chosen.to} is new, with the same settings and the same owner (${owner.table}.${owner.column}). Dropping and making it again would restart the numbering at its start and collide with the rows that exist.`,
      ],
      alternatives,
      requires: touching.get(tkey(owner.schema, owner.table)) ?? [],
    });
  }
  return out.sort((x, y) => compareText(x.id, y.id));
}

/** Everything that looks like a rename between two structures. The planner uses none of them until confirmed. */
export function suggestRenames(from: DatabaseStructure, to: DatabaseStructure): RenameSuggestion[] {
  const tables = suggestTables(from, to);
  const tableIds = new Map(tables.map((s) => [tkey(s.schema, s.newName), s.id]));
  let hyp = from;
  for (const s of tables) hyp = withTableRenamed(hyp, s.schema, s.oldName, s.newName);
  const columns = suggestColumns(hyp, to, tableIds);
  for (const s of columns) hyp = withColumnRenamed(hyp, s.schema, s.table, s.oldName, s.newName);
  const touching = new Map<string, string[]>();
  for (const s of [...tables, ...columns]) {
    const key = tkey(s.schema, s.kind === "table" ? s.newName : s.table);
    touching.set(key, [...(touching.get(key) ?? []), s.id]);
  }
  return [
    ...tables,
    ...columns,
    ...suggestSequences(hyp, to, touching),
    ...suggestNamed(hyp, to, touching),
  ];
}

// -------------------------------------------------------------------- applying

const draftFor = (s: RenameSuggestion): Draft => {
  const t = qualified(s.schema, s.table);
  switch (s.kind) {
    case "table":
      return {
        kind: "rename_table",
        object: { schema: s.schema, table: s.newName },
        up: `ALTER TABLE ${qualified(s.schema, s.oldName)} RENAME TO ${q(s.newName)};`,
        down: `ALTER TABLE ${t} RENAME TO ${q(s.oldName)};`,
        risk: ["lock"],
        note: `Renames the table ${s.oldName} to ${s.newName}. The rows stay. Anything outside the database that uses the old name stops working.`,
      };
    case "column":
      return {
        kind: "rename_column",
        object: { schema: s.schema, table: s.table, column: s.newName },
        up: `ALTER TABLE ${t} RENAME COLUMN ${q(s.oldName)} TO ${q(s.newName)};`,
        down: `ALTER TABLE ${t} RENAME COLUMN ${q(s.newName)} TO ${q(s.oldName)};`,
        risk: ["lock"],
        note: `Renames the column ${s.oldName} of ${s.table} to ${s.newName}. The values stay. Anything outside the database that uses the old name stops working.`,
      };
    case "constraint":
      return {
        kind: "rename_constraint",
        object: { schema: s.schema, table: s.table, name: s.newName },
        up: `ALTER TABLE ${t} RENAME CONSTRAINT ${q(s.oldName)} TO ${q(s.newName)};`,
        down: `ALTER TABLE ${t} RENAME CONSTRAINT ${q(s.newName)} TO ${q(s.oldName)};`,
        note: `Renames the constraint ${s.oldName} of ${s.table} to ${s.newName}.`,
      };
    case "sequence":
      return {
        kind: "rename_sequence",
        object: { schema: s.schema, table: "", of: "sequence", name: s.newName },
        up: `ALTER SEQUENCE ${qualified(s.schema, s.oldName)} RENAME TO ${q(s.newName)};`,
        down: `ALTER SEQUENCE ${qualified(s.schema, s.newName)} RENAME TO ${q(s.oldName)};`,
        note: `Renames the sequence ${s.oldName} to ${s.newName}, so its position is kept.`,
      };
    case "index":
      return {
        kind: "rename_index",
        object: { schema: s.schema, table: s.table, name: s.newName },
        up: `ALTER INDEX ${qualified(s.schema, s.oldName)} RENAME TO ${q(s.newName)};`,
        down: `ALTER INDEX ${qualified(s.schema, s.newName)} RENAME TO ${q(s.oldName)};`,
        note: `Renames the index ${s.oldName} of ${s.table} to ${s.newName}.`,
      };
  }
};

/**
 * The renames a person confirmed, as steps, and the starting structure as it is after them.
 * A confirmed id that is not (or no longer) a suggestion, or whose table or column rename was
 * not confirmed too, is ignored and listed.
 */
export function applyRenames(
  from: DatabaseStructure,
  to: DatabaseStructure,
  confirmed: readonly string[],
): AppliedRenames {
  if (confirmed.length === 0) {
    return {
      structure: from,
      drafts: [],
      applied: [],
      rewrittenViews: new Set(),
      remakeViews: new Set(),
      oldNames: [],
      ignored: [],
    };
  }
  const wanted = new Set(confirmed);
  const suggestions = suggestRenames(from, to);
  const chosen = suggestions.filter(
    (s) => wanted.has(s.id) && s.requires.every((r) => wanted.has(r)),
  );
  const ok = new Set(chosen.map((s) => s.id));
  let structure = from;
  const drafts: Draft[] = [];
  for (const s of chosen) {
    if (s.kind === "table") structure = withTableRenamed(structure, s.schema, s.oldName, s.newName);
  }
  for (const s of chosen) {
    if (s.kind === "column") {
      structure = withColumnRenamed(structure, s.schema, s.table, s.oldName, s.newName);
    }
  }
  for (const s of chosen) {
    if (s.kind === "sequence") {
      structure = withSequenceRenamed(structure, s.schema, s.oldName, s.newName);
    }
  }
  for (const s of chosen) {
    if (s.kind === "constraint") {
      structure = withConstraintRenamed(structure, s.schema, s.table, s.oldName, s.newName);
    }
  }
  for (const s of chosen) {
    if (s.kind === "index") {
      structure = withIndexRenamed(structure, s.schema, s.table, s.oldName, s.newName);
    }
  }
  for (const s of chosen) drafts.push(draftFor(s));
  const before = new Map(
    (from.objects?.views ?? []).map((v) => [tkey(v.schema, v.name), v.definition]),
  );
  const rewrittenViews = new Set(
    (structure.objects?.views ?? [])
      .filter((v) => before.get(tkey(v.schema, v.name)) !== v.definition)
      .map((v) => tkey(v.schema, v.name)),
  );
  const renamedColumnTables = new Set(
    chosen.filter((r) => r.kind === "column").map((r) => tkey(r.schema, r.table)),
  );
  const remakeViews = new Set(
    (structure.objects?.views ?? [])
      .filter((v) => v.dependsOn.some((d) => renamedColumnTables.has(tkey(d.schema, d.name))))
      .map((v) => tkey(v.schema, v.name)),
  );
  return {
    structure,
    drafts,
    applied: chosen.map((s) => s.id),
    rewrittenViews,
    remakeViews,
    oldNames: [
      ...new Set(
        chosen.filter((r) => r.kind === "table" || r.kind === "column").map((r) => r.oldName),
      ),
    ],
    ignored: [...wanted].filter((id) => !ok.has(id)).sort(compareText),
  };
}
