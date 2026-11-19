/**
 * Plan the objects around the tables: schemas, extensions, types, sequences, functions, views,
 * triggers, row-level security policies and the switch that turns it on
 * (`docs/migration-studio-plan.md`, section 3.2).
 *
 * The steps come back in three groups, which `planMigration` puts around the table steps:
 *   dropFirst   triggers, policies and views that go or must be made again, dependents first;
 *               sequences that must let go of a table or column that goes
 *   foundations schemas, extensions, types, sequences and the functions a table does not wait on
 *   last        sequence owners, functions, views (by dependency), comments, triggers, policies,
 *               row security; then what goes: functions, sequences, types, extensions, schemas
 * so a step finds what it needs made and what it leaves behind already dropped. Nothing is matched
 * by guess, and no statement contains `CASCADE`.
 *
 * What PostgreSQL cannot do, and what this does not do yet, is a warning and no step: removing or
 * reordering an enum label, changing a domain's checks or base type, changing the kind of a type.
 */
import type {
  DatabaseObjects,
  FunctionInfo,
  PolicyInfo,
  RowSecurityInfo,
  SequenceInfo,
  TriggerInfo,
  TypeInfo,
  ViewInfo,
} from "../models.js";
import type { DatabaseStructure } from "../structure.js";
import { SEP, tableKey, type Draft } from "./draft.js";
import { commentOn, q, qualified } from "./sql.js";
import { quoteString } from "../sql-text.js";
import type { ObjectType, StepObject } from "./types.js";

export interface ObjectsContext {
  from: DatabaseStructure;
  to: DatabaseStructure;
  /** `tableKey`s of the tables this plan makes and drops. */
  createdTables: Set<string>;
  droppedTables: Set<string>;
  /** `tableKey`s of tables that stay and lose or retype a column (a view that reads one must be made again). */
  disturbedTables: Set<string>;
  warnings: string[];
  /** Views (`schema SEP name`) whose starting text was rewritten for a rename: made with a column list so their columns keep their names. */
  rewrittenViews: Set<string>;
  /** Views that must be dropped and made again though their text is the same (they read a renamed column). */
  remakeViews: Set<string>;
}

export interface ObjectPhases {
  dropFirst: Draft[];
  foundations: Draft[];
  last: Draft[];
  /** What goes, after everything that used it is made or changed: functions, sequences, types, extensions, schemas. */
  finish: Draft[];
}

// ------------------------------------------------------------------ small helpers

/** Text that was cut when it was recorded cannot be run. */
const isCut = (text: string): boolean =>
  /\.\.\. \[text cut: \d+ characters, fingerprint /.test(text);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Does `text` name `name` (bare or quoted), not as part of a longer name? */
const mentions = (text: string, name: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_$])"?${escapeRegExp(name)}"?($|[^A-Za-z0-9_$])`).test(text);

/** Items so that each comes after what it needs; ties and cycles fall back to the sorted order. */
function dependencyOrder<T>(items: T[], key: (item: T) => string, needs: (item: T) => T[]): T[] {
  const sorted = [...items].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: T[] = [];
  const visit = (item: T): void => {
    const k = key(item);
    if (done.has(k) || visiting.has(k)) return;
    visiting.add(k);
    for (const dep of needs(item)) visit(dep);
    visiting.delete(k);
    done.add(k);
    out.push(item);
  };
  for (const item of sorted) visit(item);
  return out;
}

const k2 = (a: string, b: string): string => `${a}${SEP}${b}`;
const k3 = (a: string, b: string, c: string): string => `${a}${SEP}${b}${SEP}${c}`;

function byKey<T>(list: readonly T[], key: (item: T) => string): Map<string, T> {
  return new Map(list.map((item) => [key(item), item]));
}

/** Comments on schemas, types and sequences, which the structure keeps in the detail. */
function commentMap(s: DatabaseStructure, target: "schema" | "type" | "sequence") {
  const map = new Map<string, string>();
  for (const c of s.ddl?.comments ?? []) {
    if (c.target === target) map.set(k2(c.schema, c.name), c.comment);
  }
  return map;
}

const withoutSemicolon = (text: string): string => text.trim().replace(/;+$/, "");

/** The sequences (not identity ones) that a table, or one column of it, owns in a structure: they go with it. */
export function ownedSequences(
  structure: DatabaseStructure,
  schema: string,
  table: string,
  column?: string,
): SequenceInfo[] {
  return (structure.objects?.sequences ?? []).filter(
    (s) =>
      s.ownedBy !== null &&
      s.ownedBy.schema === schema &&
      s.ownedBy.table === table &&
      (column === undefined || s.ownedBy.column === column) &&
      !identitySequence(s, structure),
  );
}

/** The statement that gives a sequence back to its owner. */
export const ownedBySql = (s: SequenceInfo): string =>
  s.ownedBy === null
    ? ""
    : `ALTER SEQUENCE ${qualified(s.schema, s.name)} OWNED BY ${qualified(s.ownedBy.schema, s.ownedBy.table)}.${q(s.ownedBy.column)};`;

// --------------------------------------------------------------------- the planner

export function planObjects(ctx: ObjectsContext): ObjectPhases {
  const phases: ObjectPhases = { dropFirst: [], foundations: [], last: [], finish: [] };
  const { from, to } = ctx;
  const fo = from.objects;
  const to2 = to.objects;
  if (fo === null || to2 === null) {
    // Schemas are always recorded; the rest only when both structures have it.
    planSchemas(ctx, phases);
    return phases;
  }
  planSchemas(ctx, phases);
  planExtensions(ctx, phases, fo, to2);
  planTypes(ctx, phases, fo, to2);
  planSequences(ctx, phases, fo, to2);
  const rebuiltFunctions = planFunctions(ctx, phases, fo, to2);
  const rebuiltViews = planViews(ctx, phases, fo, to2);
  planTriggers(ctx, phases, fo, to2, rebuiltViews, rebuiltFunctions);
  planPolicies(ctx, phases, fo, to2);
  planRowSecurity(ctx, phases, fo, to2);
  return sorted(phases);
}

const GOES = ["drop_function", "drop_sequence", "drop_type", "drop_extension", "drop_schema"];
/** Triggers, policies and row security first, then sequences let go of their owners, then views. */
const FIRST = ["drop_trigger", "drop_policy", "row_security", "own_sequence", "drop_view"];
function sorted(phases: ObjectPhases): ObjectPhases {
  phases.dropFirst = phases.dropFirst
    .map((d, i) => ({ d, i }))
    .sort((x, y) => FIRST.indexOf(x.d.kind) - FIRST.indexOf(y.d.kind) || x.i - y.i)
    .map((x) => x.d);
  const rank = (d: Draft) => GOES.indexOf(d.kind);
  phases.finish = phases.finish
    .map((d, i) => ({ d, i }))
    .sort((x, y) => rank(x.d) - rank(y.d) || x.i - y.i)
    .map((x) => x.d);
  return phases;
}

const obj = (of: ObjectType, schema: string, name: string, table = ""): StepObject => ({
  schema,
  table,
  of,
  name,
});

// ------------------------------------------------------------------------- schemas

function planSchemas(ctx: ObjectsContext, phases: ObjectPhases): void {
  const before = new Set(ctx.from.schemas);
  const after = new Set(ctx.to.schemas);
  const cf = commentMap(ctx.from, "schema");
  const ct = commentMap(ctx.to, "schema");
  const recorded = ctx.from.ddl !== null && ctx.to.ddl !== null;
  for (const name of [...after].filter((n) => !before.has(n)).sort()) {
    phases.foundations.push({
      kind: "create_schema",
      object: obj("schema", name, name),
      up: `CREATE SCHEMA ${q(name)};`,
      down: `DROP SCHEMA ${q(name)};`,
      note: `Creates the schema ${name}.`,
      provides: `schema:${name}`,
    });
    const comment = ct.get(k2(name, name));
    if (recorded && comment !== undefined) {
      phases.foundations.push({
        kind: "comment_schema",
        object: obj("schema", name, name),
        up: commentOn(`SCHEMA ${q(name)}`, comment),
        down: null,
        note: `Comments the schema ${name}.`,
      });
    }
  }
  if (recorded) {
    for (const name of [...after].filter((n) => before.has(n)).sort()) {
      const was = cf.get(k2(name, name)) ?? null;
      const now = ct.get(k2(name, name)) ?? null;
      if (was === now) continue;
      phases.foundations.push({
        kind: "comment_schema",
        object: obj("schema", name, name),
        up: commentOn(`SCHEMA ${q(name)}`, now),
        down: commentOn(`SCHEMA ${q(name)}`, was),
        note: `Changes the comment on the schema ${name}.`,
      });
    }
  }
  const gone = [...before].filter((n) => !after.has(n)).sort();
  // Schemas are dropped last, after what is in them.
  for (const name of gone.reverse()) {
    const comment = cf.get(k2(name, name));
    phases.finish.push({
      kind: "drop_schema",
      object: obj("schema", name, name),
      up: `DROP SCHEMA ${q(name)};`,
      down: `CREATE SCHEMA ${q(name)};${comment === undefined ? "" : `\n${commentOn(`SCHEMA ${q(name)}`, comment)}`}`,
      risk: ["destructive", "may_fail"],
      note: `Drops the schema ${name}. It fails if anything this plan does not list is still in it.`,
    });
  }
}

// ---------------------------------------------------------------------- extensions

function planExtensions(
  ctx: ObjectsContext,
  phases: ObjectPhases,
  fo: DatabaseObjects,
  to: DatabaseObjects,
): void {
  void ctx;
  const before = byKey(fo.extensions, (e) => e.name);
  const after = byKey(to.extensions, (e) => e.name);
  for (const e of [...to.extensions].sort((x, y) => (x.name < y.name ? -1 : 1))) {
    const was = before.get(e.name);
    if (!was) {
      phases.foundations.push({
        kind: "create_extension",
        object: obj("extension", e.schema, e.name),
        up: `CREATE EXTENSION ${q(e.name)} WITH SCHEMA ${q(e.schema)};`,
        down: `DROP EXTENSION ${q(e.name)};`,
        note: `Installs the extension ${e.name}${e.version ? ` (the target has version ${e.version})` : ""}. It needs a role that may create extensions.`,
        provides: `extension:${e.name}`,
      });
      continue;
    }
    if (was.schema !== e.schema) {
      phases.foundations.push({
        kind: "update_extension",
        object: obj("extension", e.schema, e.name),
        up: `ALTER EXTENSION ${q(e.name)} SET SCHEMA ${q(e.schema)};`,
        down: `ALTER EXTENSION ${q(e.name)} SET SCHEMA ${q(was.schema)};`,
        risk: ["may_fail"],
        note: `Moves the extension ${e.name} to the schema ${e.schema}. It fails if the extension cannot be moved.`,
      });
    }
    if (was.version !== e.version) {
      phases.foundations.push({
        kind: "update_extension",
        object: obj("extension", e.schema, e.name),
        up: `ALTER EXTENSION ${q(e.name)} UPDATE TO ${quoteString(e.version)};`,
        down: null,
        risk: ["may_fail"],
        reversibility: "none",
        note: `Updates the extension ${e.name} from ${was.version} to ${e.version}. An extension cannot be taken back to an earlier version.`,
      });
    }
  }
  for (const e of [...fo.extensions]
    .filter((x) => !after.has(x.name))
    .sort((x, y) => (x.name < y.name ? 1 : -1))) {
    phases.finish.push({
      kind: "drop_extension",
      object: obj("extension", e.schema, e.name),
      up: `DROP EXTENSION ${q(e.name)};`,
      down: `CREATE EXTENSION ${q(e.name)} WITH SCHEMA ${q(e.schema)};`,
      risk: ["destructive", "may_fail"],
      note: `Removes the extension ${e.name} and everything it made. It fails if something still uses it.`,
    });
  }
}

// ------------------------------------------------------------------------- types

const typeDefinitionSql = (t: TypeInfo): string => {
  const name = qualified(t.schema, t.name);
  switch (t.kind) {
    case "enum":
      return `CREATE TYPE ${name} AS ENUM (${t.values.map(quoteString).join(", ")});`;
    case "composite":
      return `CREATE TYPE ${name} AS (${t.attributes.map((a) => `${q(a.name)} ${a.dataType}`).join(", ")});`;
    case "range":
      return `CREATE TYPE ${name} AS RANGE (SUBTYPE = ${t.baseType ?? ""});`;
    case "domain": {
      const parts = [`CREATE DOMAIN ${name} AS ${t.baseType ?? ""}`];
      if (t.defaultValue !== null) parts.push(`DEFAULT ${t.defaultValue}`);
      for (const c of t.constraints) parts.push(c);
      return `${parts.join(" ")};`;
    }
  }
};

const typeText = (t: TypeInfo): string =>
  [
    t.baseType ?? "",
    ...t.attributes.map((a) => a.dataType),
    ...t.constraints,
    t.defaultValue ?? "",
  ].join(" ");

function planTypes(
  ctx: ObjectsContext,
  phases: ObjectPhases,
  fo: DatabaseObjects,
  to: DatabaseObjects,
): void {
  const before = byKey(fo.types, (t) => k2(t.schema, t.name));
  const after = byKey(to.types, (t) => k2(t.schema, t.name));
  const cf = commentMap(ctx.from, "type");
  const ct = commentMap(ctx.to, "type");
  const recorded = ctx.from.ddl !== null && ctx.to.ddl !== null;
  const usesOther = (list: TypeInfo[]) => (t: TypeInfo) =>
    list.filter((o) => o !== t && mentions(typeText(t), o.name));

  const added = to.types.filter((t) => !before.has(k2(t.schema, t.name)));
  for (const t of dependencyOrder(added, (x) => k2(x.schema, x.name), usesOther(added))) {
    phases.foundations.push({
      kind: "create_type",
      object: obj("type", t.schema, t.name),
      up: typeDefinitionSql(t),
      down: `DROP TYPE ${qualified(t.schema, t.name)};`,
      note: `Creates the ${t.kind} type ${t.name}.`,
      provides: `type:${k2(t.schema, t.name)}`,
      needs: [`schema:${t.schema}`],
    });
    const comment = ct.get(k2(t.schema, t.name));
    if (recorded && comment !== undefined) {
      phases.foundations.push({
        kind: "comment_type",
        object: obj("type", t.schema, t.name),
        up: commentOn(`TYPE ${qualified(t.schema, t.name)}`, comment),
        down: null,
        note: `Comments the type ${t.name}.`,
      });
    }
  }

  for (const t of to.types) {
    const was = before.get(k2(t.schema, t.name));
    if (!was) continue;
    const name = qualified(t.schema, t.name);
    const object = obj("type", t.schema, t.name);
    if (was.kind !== t.kind) {
      ctx.warnings.push(
        `The type ${t.name} is a ${was.kind} type and becomes a ${t.kind} type. The plan does not change what kind of type something is: drop it and make it again by hand.`,
      );
      continue;
    }
    if (t.kind === "enum") {
      const oldValues = was.values;
      const stays = oldValues.every((v) => t.values.includes(v));
      const sameOrder =
        stays && t.values.filter((v) => oldValues.includes(v)).join(SEP) === oldValues.join(SEP);
      if (!stays || !sameOrder) {
        ctx.warnings.push(
          `The enum ${t.name} loses a label or changes the order of its labels. PostgreSQL cannot do that to a type: the type has to be made again and the columns that use it converted, which this plan does not do.`,
        );
      }
      if (stays && sameOrder) {
        t.values.forEach((label, i) => {
          if (oldValues.includes(label)) return;
          const position =
            i > 0
              ? ` AFTER ${quoteString(t.values[i - 1]!)}`
              : t.values.length > 1
                ? ` BEFORE ${quoteString(t.values[1]!)}`
                : "";
          phases.foundations.push({
            kind: "alter_type",
            object,
            up: `ALTER TYPE ${name} ADD VALUE ${quoteString(label)}${position};`,
            down: null,
            reversibility: "none",
            transactional: false,
            note: `Adds the label ${label} to the enum ${t.name}. A label cannot be taken out again, and a new label cannot be used in the transaction that adds it.`,
          });
        });
      }
    } else if (t.kind === "composite") {
      const oldAttrs = byKey(was.attributes, (a) => a.name);
      const newAttrs = byKey(t.attributes, (a) => a.name);
      const keptOrder = (list: { name: string }[], other: Map<string, unknown>) =>
        list
          .filter((a) => other.has(a.name))
          .map((a) => a.name)
          .join(SEP);
      if (keptOrder(was.attributes, newAttrs) !== keptOrder(t.attributes, oldAttrs)) {
        ctx.warnings.push(
          `The composite type ${t.name} changes the order of its attributes. The plan does not do that.`,
        );
      }
      for (const a of was.attributes) {
        if (newAttrs.has(a.name)) continue;
        phases.foundations.push({
          kind: "alter_type",
          object,
          up: `ALTER TYPE ${name} DROP ATTRIBUTE ${q(a.name)};`,
          down: `ALTER TYPE ${name} ADD ATTRIBUTE ${q(a.name)} ${a.dataType};`,
          risk: ["destructive", "may_fail"],
          reversibility: "data_lost",
          note: `Drops the attribute ${a.name} of the type ${t.name}. Values stored in it are lost.`,
        });
      }
      for (const a of t.attributes) {
        const w = oldAttrs.get(a.name);
        if (!w) {
          phases.foundations.push({
            kind: "alter_type",
            object,
            up: `ALTER TYPE ${name} ADD ATTRIBUTE ${q(a.name)} ${a.dataType};`,
            down: `ALTER TYPE ${name} DROP ATTRIBUTE ${q(a.name)};`,
            risk: ["may_fail"],
            note: `Adds the attribute ${a.name} to the type ${t.name}.`,
          });
        } else if (w.dataType !== a.dataType) {
          phases.foundations.push({
            kind: "alter_type",
            object,
            up: `ALTER TYPE ${name} ALTER ATTRIBUTE ${q(a.name)} SET DATA TYPE ${a.dataType};`,
            down: `ALTER TYPE ${name} ALTER ATTRIBUTE ${q(a.name)} SET DATA TYPE ${w.dataType};`,
            risk: ["may_fail"],
            note: `Changes the type of the attribute ${a.name} of ${t.name} from ${w.dataType} to ${a.dataType}.`,
          });
        }
      }
    } else if (t.kind === "domain") {
      const notNull = (x: TypeInfo) => x.constraints.includes("NOT NULL");
      const checks = (x: TypeInfo) => x.constraints.filter((c) => c !== "NOT NULL").join(SEP);
      if (was.baseType !== t.baseType || checks(was) !== checks(t)) {
        ctx.warnings.push(
          `The domain ${t.name} changes its base type or its checks. The plan does not change those: they have no names to drop by.`,
        );
      }
      if (was.defaultValue !== t.defaultValue) {
        const set = (x: string | null) =>
          x === null
            ? `ALTER DOMAIN ${name} DROP DEFAULT;`
            : `ALTER DOMAIN ${name} SET DEFAULT ${x};`;
        phases.foundations.push({
          kind: "alter_type",
          object,
          up: set(t.defaultValue),
          down: set(was.defaultValue),
          note: `Changes the default of the domain ${t.name}.`,
        });
      }
      if (notNull(was) !== notNull(t)) {
        const set = (on: boolean) => `ALTER DOMAIN ${name} ${on ? "SET" : "DROP"} NOT NULL;`;
        phases.foundations.push({
          kind: "alter_type",
          object,
          up: set(notNull(t)),
          down: set(notNull(was)),
          risk: notNull(t) ? ["may_fail"] : [],
          note: `${notNull(t) ? "Forbids" : "Allows"} NULL in the domain ${t.name}.${notNull(t) ? " It fails if a column of this domain holds NULL." : ""}`,
        });
      }
    } else if (was.baseType !== t.baseType) {
      ctx.warnings.push(`The range type ${t.name} changes its subtype. The plan does not do that.`);
    }
    if (recorded) {
      const w = cf.get(k2(t.schema, t.name)) ?? null;
      const n = ct.get(k2(t.schema, t.name)) ?? null;
      if (w !== n) {
        phases.foundations.push({
          kind: "comment_type",
          object,
          up: commentOn(`TYPE ${name}`, n),
          down: commentOn(`TYPE ${name}`, w),
          note: `Changes the comment on the type ${t.name}.`,
        });
      }
    }
  }

  const gone = fo.types.filter((t) => !after.has(k2(t.schema, t.name)));
  const goneOrder = dependencyOrder(gone, (x) => k2(x.schema, x.name), usesOther(gone)).reverse();
  for (const t of goneOrder) {
    const comment = cf.get(k2(t.schema, t.name));
    phases.finish.push({
      kind: "drop_type",
      object: obj("type", t.schema, t.name),
      up: `DROP TYPE ${qualified(t.schema, t.name)};`,
      down: `${typeDefinitionSql(t)}${comment === undefined ? "" : `\n${commentOn(`TYPE ${qualified(t.schema, t.name)}`, comment)}`}`,
      risk: ["destructive", "may_fail"],
      note: `Drops the ${t.kind} type ${t.name}. It fails if a column, function or other type still uses it.`,
    });
  }
}

// ---------------------------------------------------------------------- sequences

/** A sequence a column owns because the column is an identity column has no sequence of its own to plan. */
function identitySequence(s: SequenceInfo, structure: DatabaseStructure): boolean {
  if (s.ownedBy === null) return false;
  const table = structure.tables.find(
    (t) => t.schema === s.ownedBy!.schema && t.name === s.ownedBy!.table,
  );
  const column = table?.columns.find((c) => c.name === s.ownedBy!.column);
  if (!column) return false;
  return column.defaultValue === null || !/nextval\(/i.test(column.defaultValue);
}

const sequenceOptions = (s: SequenceInfo): string =>
  `AS ${s.dataType} INCREMENT BY ${s.increment} MINVALUE ${s.min} MAXVALUE ${s.max} START WITH ${s.start} CACHE ${s.cache} ${s.cycle ? "CYCLE" : "NO CYCLE"}`;

function planSequences(
  ctx: ObjectsContext,
  phases: ObjectPhases,
  fo: DatabaseObjects,
  to: DatabaseObjects,
): void {
  const mine = (list: SequenceInfo[], s: DatabaseStructure) =>
    list.filter((x) => !identitySequence(x, s));
  const fromSeqs = mine(fo.sequences, ctx.from);
  const toSeqs = mine(to.sequences, ctx.to);
  const before = byKey(fromSeqs, (s) => k2(s.schema, s.name));
  const after = byKey(toSeqs, (s) => k2(s.schema, s.name));
  const cf = commentMap(ctx.from, "sequence");
  const ct = commentMap(ctx.to, "sequence");
  const recorded = ctx.from.ddl !== null && ctx.to.ddl !== null;
  const owner = (s: SequenceInfo) =>
    s.ownedBy === null ? "" : k3(s.ownedBy.schema, s.ownedBy.table, s.ownedBy.column);

  for (const s of toSeqs) {
    const was = before.get(k2(s.schema, s.name));
    const name = qualified(s.schema, s.name);
    const object = obj("sequence", s.schema, s.name);
    if (!was) {
      phases.foundations.push({
        kind: "create_sequence",
        object,
        up: `CREATE SEQUENCE ${name} ${sequenceOptions(s)};`,
        down: `DROP SEQUENCE ${name};`,
        note: `Creates the sequence ${s.name}. It starts at ${s.start}: the position of another database's sequence is data and is not copied.`,
        provides: `sequence:${k2(s.schema, s.name)}`,
        needs: [`schema:${s.schema}`],
      });
      const comment = ct.get(k2(s.schema, s.name));
      if (recorded && comment !== undefined) {
        phases.foundations.push({
          kind: "comment_sequence",
          object,
          up: commentOn(`SEQUENCE ${name}`, comment),
          down: null,
          note: `Comments the sequence ${s.name}.`,
        });
      }
    } else {
      if (sequenceOptions(was) !== sequenceOptions(s)) {
        phases.foundations.push({
          kind: "alter_sequence",
          object,
          up: `ALTER SEQUENCE ${name} ${sequenceOptions(s)};`,
          down: `ALTER SEQUENCE ${name} ${sequenceOptions(was)};`,
          risk: was.dataType !== s.dataType ? ["may_fail"] : [],
          note: `Changes the settings of the sequence ${s.name}.`,
        });
      }
      if (recorded) {
        const w = cf.get(k2(s.schema, s.name)) ?? null;
        const n = ct.get(k2(s.schema, s.name)) ?? null;
        if (w !== n) {
          phases.foundations.push({
            kind: "comment_sequence",
            object,
            up: commentOn(`SEQUENCE ${name}`, n),
            down: commentOn(`SEQUENCE ${name}`, w),
            note: `Changes the comment on the sequence ${s.name}.`,
          });
        }
      }
      if (owner(was) !== owner(s)) {
        if (was.ownedBy !== null) {
          phases.dropFirst.push({
            kind: "own_sequence",
            object,
            up: `ALTER SEQUENCE ${name} OWNED BY NONE;`,
            down: ownedBySql(was),
            note: `Lets the sequence ${s.name} go of the column that owns it, so dropping that column keeps the sequence.`,
          });
        }
        if (s.ownedBy !== null) {
          phases.last.push({
            kind: "own_sequence",
            object,
            up: ownedBySql(s),
            down: `ALTER SEQUENCE ${name} OWNED BY NONE;`,
            note: `Gives the sequence ${s.name} to the column ${s.ownedBy.column} of ${s.ownedBy.table}.`,
            ...(ctx.createdTables.has(tableKey(s.ownedBy.schema, s.ownedBy.table))
              ? { dependsOnTable: tableKey(s.ownedBy.schema, s.ownedBy.table) }
              : {}),
          });
        }
      }
      continue;
    }
    if (s.ownedBy !== null) {
      phases.last.push({
        kind: "own_sequence",
        object,
        up: ownedBySql(s),
        down: `ALTER SEQUENCE ${name} OWNED BY NONE;`,
        note: `Gives the sequence ${s.name} to the column ${s.ownedBy.column} of ${s.ownedBy.table}.`,
        ...(ctx.createdTables.has(tableKey(s.ownedBy.schema, s.ownedBy.table))
          ? { dependsOnTable: tableKey(s.ownedBy.schema, s.ownedBy.table) }
          : {}),
      });
    }
  }

  for (const s of fromSeqs.filter((x) => !after.has(k2(x.schema, x.name))).reverse()) {
    const name = qualified(s.schema, s.name);
    const comment = cf.get(k2(s.schema, s.name));
    const restore = `CREATE SEQUENCE ${name} ${sequenceOptions(s)};${comment === undefined ? "" : `\n${commentOn(`SEQUENCE ${name}`, comment)}`}`;
    // A sequence a table or a column owns goes with it: PostgreSQL drops both together.
    const ownerTable = s.ownedBy ? tableKey(s.ownedBy.schema, s.ownedBy.table) : null;
    const goesWithOwner =
      s.ownedBy !== null &&
      (ctx.droppedTables.has(ownerTable!) ||
        !ctx.to.tables.some(
          (t) =>
            t.schema === s.ownedBy!.schema &&
            t.name === s.ownedBy!.table &&
            t.columns.some((c) => c.name === s.ownedBy!.column),
        ));
    phases.finish.push({
      kind: "drop_sequence",
      object: obj("sequence", s.schema, s.name),
      up: goesWithOwner
        ? `-- The sequence ${name} is dropped with the column or table that owns it.`
        : `DROP SEQUENCE ${name};`,
      down: restore,
      risk: ["destructive"],
      reversibility: "data_lost",
      note: `Drops the sequence ${s.name}. Its position is lost: the rollback makes it again from its start.`,
    });
  }
}

// ---------------------------------------------------------------------- functions

const functionKey = (f: FunctionInfo): string => k3(f.schema, f.name, `${f.kind}(${f.arguments})`);
const functionTarget = (f: FunctionInfo): string =>
  `${f.kind === "procedure" ? "PROCEDURE" : "FUNCTION"} ${qualified(f.schema, f.name)}(${f.arguments})`;
const createFunctionSql = (f: FunctionInfo): string => `${withoutSemicolon(f.definition)};`;
const dropFunctionSql = (f: FunctionInfo): string => `DROP ${functionTarget(f)};`;

/** Returns the `schema.name` of functions that are dropped and made again (what runs them is rebuilt too). */
function planFunctions(
  ctx: ObjectsContext,
  phases: ObjectPhases,
  fo: DatabaseObjects,
  to: DatabaseObjects,
): Set<string> {
  const before = byKey(fo.functions, functionKey);
  const after = byKey(to.functions, functionKey);
  const rebuilt = new Set<string>();
  const cut = (f: FunctionInfo) => isCut(f.definition) || f.definition === "";
  const names = [
    ...[...ctx.createdTables].map((k) => k.split(SEP)[1]!),
    ...to.views
      .filter((v) => !byKey(fo.views, (x) => k2(x.schema, x.name)).has(k2(v.schema, v.name)))
      .map((v) => v.name),
  ];

  const added = to.functions.filter((f) => !before.has(functionKey(f)));
  const ordered = dependencyOrder(added, functionKey, (f) =>
    added.filter((o) => o !== f && mentions(f.definition, o.name)),
  );
  for (const f of ordered) {
    if (cut(f)) {
      ctx.warnings.push(
        `The function ${f.name} is too long to have been recorded whole, so the plan does not create it.`,
      );
      continue;
    }
    const waits = names.some((n) => mentions(f.definition, n));
    const draft: Draft = {
      kind: "create_function",
      object: obj("function", f.schema, `${f.name}(${f.arguments})`),
      up: createFunctionSql(f),
      down: dropFunctionSql(f),
      note: `Creates the ${f.kind} ${f.name}.`,
      provides: `function:${functionKey(f)}`,
      needs: [`schema:${f.schema}`],
    };
    (waits ? phases.last : phases.foundations).push(draft);
    if (f.comment !== null) {
      (waits ? phases.last : phases.foundations).push({
        kind: "comment_function",
        object: draft.object,
        up: commentOn(functionTarget(f), f.comment),
        down: null,
        note: `Comments the ${f.kind} ${f.name}.`,
      });
    }
  }

  for (const f of to.functions) {
    const was = before.get(functionKey(f));
    if (!was) continue;
    const object = obj("function", f.schema, `${f.name}(${f.arguments})`);
    if (was.definition !== f.definition) {
      if (cut(f) || cut(was)) {
        ctx.warnings.push(
          `The function ${f.name} differs, but its text is too long to have been recorded whole, so the plan does not change it.`,
        );
      } else if (was.returns !== f.returns) {
        rebuilt.add(`${f.schema}.${f.name}`);
        phases.last.push({
          kind: "drop_function",
          object,
          up: dropFunctionSql(was),
          down: createFunctionSql(was),
          risk: ["destructive", "may_fail"],
          note: `Drops the ${was.kind} ${was.name} to make it again: its result type changes from ${was.returns ?? "nothing"} to ${f.returns ?? "nothing"}, which CREATE OR REPLACE cannot do. It fails if something outside this plan uses it.`,
        });
        phases.last.push({
          kind: "create_function",
          object,
          up: createFunctionSql(f),
          down: dropFunctionSql(f),
          note: `Makes the ${f.kind} ${f.name} again with its new result type.`,
          provides: `function:${functionKey(f)}`,
        });
      } else {
        phases.last.push({
          kind: "replace_function",
          object,
          up: createFunctionSql(f),
          down: createFunctionSql(was),
          note: `Replaces the body of the ${f.kind} ${f.name}.`,
          provides: `function:${functionKey(f)}`,
        });
      }
    }
    if (was.comment !== f.comment) {
      phases.last.push({
        kind: "comment_function",
        object,
        up: commentOn(functionTarget(f), f.comment),
        down: commentOn(functionTarget(f), was.comment),
        note: `Changes the comment on the ${f.kind} ${f.name}.`,
      });
    }
  }

  for (const f of fo.functions.filter((x) => !after.has(functionKey(x))).reverse()) {
    if (cut(f)) {
      ctx.warnings.push(
        `The function ${f.name} goes, but its text was too long to be recorded whole: the rollback cannot bring it back.`,
      );
    }
    phases.finish.push({
      kind: "drop_function",
      object: obj("function", f.schema, `${f.name}(${f.arguments})`),
      up: dropFunctionSql(f),
      down: cut(f)
        ? null
        : `${createFunctionSql(f)}${f.comment === null ? "" : `\n${commentOn(functionTarget(f), f.comment)}`}`,
      risk: ["destructive", "may_fail"],
      reversibility: cut(f) ? "none" : "full",
      note: `Drops the ${f.kind} ${f.name}. It fails if a default, a check or something outside this plan still uses it.`,
    });
  }
  return rebuilt;
}

// ------------------------------------------------------------------------- views

const viewKind = (v: ViewInfo): string => (v.materialized ? "MATERIALIZED VIEW" : "VIEW");
const viewTarget = (v: ViewInfo): string => `${viewKind(v)} ${qualified(v.schema, v.name)}`;
const createViewSql = (v: ViewInfo, replace = false, columns: string[] | null = null): string =>
  `CREATE ${replace ? "OR REPLACE " : ""}${viewKind(v)} ${qualified(v.schema, v.name)}${
    columns === null ? "" : ` (${columns.map(q).join(", ")})`
  } AS\n${withoutSemicolon(v.definition)};`;

function planViews(
  ctx: ObjectsContext,
  phases: ObjectPhases,
  fo: DatabaseObjects,
  to: DatabaseObjects,
): Set<string> {
  const before = byKey(fo.views, (v) => k2(v.schema, v.name));
  const after = byKey(to.views, (v) => k2(v.schema, v.name));
  const columnsOf = (s: DatabaseStructure, v: ViewInfo) =>
    s.tables.find((t) => t.schema === v.schema && t.name === v.name)?.columns ?? null;
  const indexesOf = (s: DatabaseStructure, v: ViewInfo) =>
    (s.tables.find((t) => t.schema === v.schema && t.name === v.name)?.indexes ?? []).sort(
      (x, y) => (x.name < y.name ? -1 : 1),
    );

  const rewritten = (v: ViewInfo): string[] | null =>
    ctx.rewrittenViews.has(k2(v.schema, v.name))
      ? (columnsOf(ctx.from, v) ?? [])
          .sort((x, y) => x.ordinalPosition - y.ordinalPosition)
          .map((c) => c.name)
      : null;

  // A changed view can be replaced in place only if it keeps its columns and adds at the end.
  const replaceable = (was: ViewInfo, now: ViewInfo): boolean => {
    if (was.materialized || now.materialized) return false;
    const x = columnsOf(ctx.from, was);
    const y = columnsOf(ctx.to, now);
    if (x === null || y === null || y.length < x.length) return false;
    return x.every((c, i) => c.name === y[i]!.name && c.dataType === y[i]!.dataType);
  };

  const rebuild = new Set<string>(); // view keys dropped and made again, or dropped for good
  const gone = new Set<string>();
  for (const v of fo.views) {
    const now = after.get(k2(v.schema, v.name));
    if (!now) {
      gone.add(k2(v.schema, v.name));
      rebuild.add(k2(v.schema, v.name));
    } else if (ctx.remakeViews.has(k2(v.schema, v.name))) {
      rebuild.add(k2(v.schema, v.name));
    } else if (v.definition !== now.definition || v.materialized !== now.materialized) {
      if (!replaceable(v, now)) rebuild.add(k2(v.schema, v.name));
    }
  }
  // A view that reads a table whose column goes or changes type, or a view that is dropped.
  let grew = true;
  while (grew) {
    grew = false;
    for (const v of fo.views) {
      const key = k2(v.schema, v.name);
      if (rebuild.has(key)) continue;
      const readsDisturbed = v.dependsOn.some(
        (d) =>
          ctx.disturbedTables.has(tableKey(d.schema, d.name)) ||
          ctx.droppedTables.has(tableKey(d.schema, d.name)) ||
          rebuild.has(k2(d.schema, d.name)),
      );
      if (readsDisturbed) {
        rebuild.add(key);
        grew = true;
      }
    }
  }

  const doomed = fo.views.filter((v) => rebuild.has(k2(v.schema, v.name)));
  // What a view reads comes first; dropping goes the other way round, dependents first.
  const dropOrder = dependencyOrder(
    doomed,
    (v) => k2(v.schema, v.name),
    (v) =>
      doomed.filter((o) => v.dependsOn.some((d) => d.schema === o.schema && d.name === o.name)),
  ).reverse();

  for (const v of dropOrder) {
    const indexes = v.materialized
      ? indexesOf(ctx.from, v)
          .map((i) => `\n${withoutSemicolon(i.definition ?? "")};`)
          .join("")
      : "";
    phases.dropFirst.push({
      kind: "drop_view",
      object: obj("view", v.schema, v.name),
      up: `DROP ${viewTarget(v)};`,
      down: `${isCut(v.definition) ? `-- The text of ${v.name} was too long to be recorded.` : createViewSql(v, false, rewritten(v))}${indexes}${v.comment === null ? "" : `\n${commentOn(viewTarget(v), v.comment)}`}`,
      risk: ["destructive"],
      reversibility: isCut(v.definition) ? "none" : "full",
      note: gone.has(k2(v.schema, v.name))
        ? `Drops the ${v.materialized ? "materialized view" : "view"} ${v.name}.`
        : `Drops the ${v.materialized ? "materialized view" : "view"} ${v.name} to make it again: it changes, or it reads something that changes.`,
    });
  }

  const toMake = to.views.filter((v) => {
    const key = k2(v.schema, v.name);
    const was = before.get(key);
    return (
      !was ||
      rebuild.has(key) ||
      was.definition !== v.definition ||
      was.materialized !== v.materialized
    );
  });
  const ordered = dependencyOrder(
    toMake,
    (v) => k2(v.schema, v.name),
    (v) =>
      toMake.filter((o) => v.dependsOn.some((d) => d.schema === o.schema && d.name === o.name)),
  );
  for (const v of ordered) {
    const key = k2(v.schema, v.name);
    const was = before.get(key);
    if (isCut(v.definition)) {
      ctx.warnings.push(
        `The text of the view ${v.name} was too long to be recorded whole, so the plan does not create it.`,
      );
      continue;
    }
    const needs = [...v.dependsOn.map((d) => `view:${k2(d.schema, d.name)}`), `schema:${v.schema}`];
    const target = viewTarget(v);
    if (was && !rebuild.has(key)) {
      phases.last.push({
        kind: "replace_view",
        object: obj("view", v.schema, v.name),
        up: createViewSql(v, true),
        // A view cannot lose columns by being replaced, so going back drops it and makes it again
        // (which fails if another view reads it).
        down: `DROP ${target};\n${createViewSql(was, false, rewritten(was))}${was.comment === null ? "" : `\n${commentOn(target, was.comment)}`}`,
        note: `Replaces the query of the view ${v.name} (it keeps its columns and adds at the end). Going back drops the view and makes it again, which fails if another view reads it.`,
        provides: `view:${key}`,
        needs,
      });
    } else {
      const indexes = v.materialized
        ? indexesOf(ctx.to, v)
            .map((i) => `\n${withoutSemicolon(i.definition ?? "")};`)
            .join("")
        : "";
      phases.last.push({
        kind: "create_view",
        object: obj("view", v.schema, v.name),
        up: `${createViewSql(v)}${indexes}`,
        down: `DROP ${target};`,
        note: `${was ? "Makes" : "Creates"} the ${v.materialized ? "materialized view" : "view"} ${v.name}${was ? " again" : ""}.${v.materialized ? " A materialized view is filled when it is made, which can take a while." : ""}`,
        provides: `view:${key}`,
        needs,
      });
    }
    const wasComment = was && !rebuild.has(key) ? was.comment : null;
    if (v.comment !== wasComment) {
      phases.last.push({
        kind: "comment_view",
        object: obj("view", v.schema, v.name),
        up: commentOn(target, v.comment),
        down: was && !rebuild.has(key) ? commentOn(target, was.comment) : null,
        note: `${was && !rebuild.has(key) ? "Changes" : "Sets"} the comment on the view ${v.name}.`,
      });
    }
  }
  // A materialized view that stays but whose indexes differ.
  for (const v of to.views) {
    const key = k2(v.schema, v.name);
    const was = before.get(key);
    if (!v.materialized || !was || rebuild.has(key)) continue;
    const a = indexesOf(ctx.from, was)
      .map((i) => i.definition)
      .join("\n");
    const b = indexesOf(ctx.to, v)
      .map((i) => i.definition)
      .join("\n");
    if (a !== b) {
      ctx.warnings.push(
        `The indexes of the materialized view ${v.name} differ. The plan does not change them.`,
      );
    }
  }
  return rebuild;
}

// ----------------------------------------------------------------------- triggers

const triggerKey = (t: TriggerInfo): string => k3(t.schema, t.table, t.name);
const triggerOn = (t: TriggerInfo): string => qualified(t.schema, t.table);
const stateSql = (t: TriggerInfo): string => {
  const on = `ALTER TABLE ${triggerOn(t)}`;
  switch (t.state) {
    case "disabled":
      return `${on} DISABLE TRIGGER ${q(t.name)};`;
    case "replica":
      return `${on} ENABLE REPLICA TRIGGER ${q(t.name)};`;
    case "always":
      return `${on} ENABLE ALWAYS TRIGGER ${q(t.name)};`;
    case "enabled":
      return `${on} ENABLE TRIGGER ${q(t.name)};`;
  }
};
const createTriggerSql = (t: TriggerInfo): string =>
  `${withoutSemicolon(t.definition)};${t.state === "enabled" ? "" : `\n${stateSql(t)}`}`;

function planTriggers(
  ctx: ObjectsContext,
  phases: ObjectPhases,
  fo: DatabaseObjects,
  to: DatabaseObjects,
  rebuiltViews: Set<string>,
  rebuiltFunctions: Set<string>,
): void {
  const before = byKey(fo.triggers, triggerKey);
  const after = byKey(to.triggers, triggerKey);
  const remake = (t: TriggerInfo): boolean =>
    rebuiltViews.has(k2(t.schema, t.table)) || rebuiltFunctions.has(t.function);
  const changed = (was: TriggerInfo, now: TriggerInfo): boolean =>
    was.definition !== now.definition || remake(now);

  for (const t of fo.triggers) {
    const now = after.get(triggerKey(t));
    if (now && !changed(t, now)) continue;
    phases.dropFirst.push({
      kind: "drop_trigger",
      object: obj("trigger", t.schema, t.name, t.table),
      up: `DROP TRIGGER ${q(t.name)} ON ${triggerOn(t)};`,
      down: isCut(t.definition) ? null : createTriggerSql(t),
      risk: ["destructive"],
      reversibility: isCut(t.definition) ? "none" : "full",
      note: now
        ? `Drops the trigger ${t.name} on ${t.table} to make it again: it changes, or what it runs or sits on is made again.`
        : `Drops the trigger ${t.name} on ${t.table}.`,
    });
  }
  for (const t of to.triggers) {
    const was = before.get(triggerKey(t));
    const object = obj("trigger", t.schema, t.name, t.table);
    if (!was || changed(was, t)) {
      if (isCut(t.definition)) {
        ctx.warnings.push(
          `The trigger ${t.name} is too long to have been recorded whole, so the plan does not create it.`,
        );
        continue;
      }
      phases.last.push({
        kind: "create_trigger",
        object,
        up: createTriggerSql(t),
        down: `DROP TRIGGER ${q(t.name)} ON ${triggerOn(t)};`,
        note: `Creates the trigger ${t.name} on ${t.table}.`,
        ...(ctx.createdTables.has(tableKey(t.schema, t.table))
          ? { dependsOnTable: tableKey(t.schema, t.table) }
          : {}),
      });
    } else if (was.state !== t.state) {
      phases.last.push({
        kind: "alter_trigger",
        object,
        up: stateSql(t),
        down: stateSql(was),
        note: `Changes whether the trigger ${t.name} on ${t.table} is enabled (${was.state} to ${t.state}).`,
      });
    }
  }
}

// ----------------------------------------------------------------------- policies

const roleSql = (r: string): string => (r === "public" ? "PUBLIC" : q(r));
const policyKey = (p: PolicyInfo): string => k3(p.schema, p.table, p.name);
const policyOn = (p: PolicyInfo): string => `${q(p.name)} ON ${qualified(p.schema, p.table)}`;
const createPolicySql = (p: PolicyInfo): string =>
  `CREATE POLICY ${policyOn(p)} AS ${p.permissive ? "PERMISSIVE" : "RESTRICTIVE"} FOR ${p.command.toUpperCase()}${
    p.roles.length > 0 ? ` TO ${p.roles.map(roleSql).join(", ")}` : ""
  }${p.using !== null ? ` USING (${p.using})` : ""}${p.withCheck !== null ? ` WITH CHECK (${p.withCheck})` : ""};`;
const alterPolicySql = (p: PolicyInfo): string =>
  `ALTER POLICY ${policyOn(p)}${p.roles.length > 0 ? ` TO ${p.roles.map(roleSql).join(", ")}` : ""}${
    p.using !== null ? ` USING (${p.using})` : ""
  }${p.withCheck !== null ? ` WITH CHECK (${p.withCheck})` : ""};`;
/** `ALTER POLICY` cannot remove an expression or the list of roles, and cannot change the kind. */
const canAlter = (was: PolicyInfo, now: PolicyInfo): boolean =>
  was.permissive === now.permissive &&
  was.command === now.command &&
  (was.using === null || now.using !== null) &&
  (was.withCheck === null || now.withCheck !== null) &&
  now.roles.length > 0;
const samePolicy = (x: PolicyInfo, y: PolicyInfo): boolean =>
  x.permissive === y.permissive &&
  x.command === y.command &&
  x.using === y.using &&
  x.withCheck === y.withCheck &&
  x.roles.join(SEP) === y.roles.join(SEP);

function planPolicies(
  ctx: ObjectsContext,
  phases: ObjectPhases,
  fo: DatabaseObjects,
  to: DatabaseObjects,
): void {
  const before = byKey(fo.policies, policyKey);
  const after = byKey(to.policies, policyKey);
  for (const p of fo.policies) {
    const now = after.get(policyKey(p));
    if (now && (samePolicy(p, now) || canAlter(p, now))) continue;
    phases.dropFirst.push({
      kind: "drop_policy",
      object: obj("policy", p.schema, p.name, p.table),
      up: `DROP POLICY ${policyOn(p)};`,
      down: createPolicySql(p),
      risk: ["destructive"],
      note: now
        ? `Drops the policy ${p.name} on ${p.table} to make it again.`
        : `Drops the policy ${p.name} on ${p.table}.`,
    });
  }
  for (const p of to.policies) {
    const was = before.get(policyKey(p));
    const object = obj("policy", p.schema, p.name, p.table);
    if (!was || !canAlter(was, p)) {
      if (was && samePolicy(was, p)) continue;
      phases.last.push({
        kind: "create_policy",
        object,
        up: createPolicySql(p),
        down: `DROP POLICY ${policyOn(p)};`,
        note: `Creates the policy ${p.name} on ${p.table}.`,
        ...(ctx.createdTables.has(tableKey(p.schema, p.table))
          ? { dependsOnTable: tableKey(p.schema, p.table) }
          : {}),
      });
    } else if (!samePolicy(was, p)) {
      phases.last.push({
        kind: "alter_policy",
        object,
        up: alterPolicySql(p),
        // Going back may need an expression removed, which ALTER POLICY cannot do.
        down: canAlter(p, was)
          ? alterPolicySql(was)
          : `DROP POLICY ${policyOn(p)};\n${createPolicySql(was)}`,
        note: `Changes the policy ${p.name} on ${p.table}.`,
      });
    }
  }
}

// ------------------------------------------------------------------ row security

const rlsOn = (r: RowSecurityInfo): string => `ALTER TABLE ${qualified(r.schema, r.table)}`;
const enableRls = (r: RowSecurityInfo): string =>
  `${rlsOn(r)} ENABLE ROW LEVEL SECURITY;${r.forced ? `\n${rlsOn(r)} FORCE ROW LEVEL SECURITY;` : ""}`;
const disableRls = (r: RowSecurityInfo): string =>
  `${r.forced ? `${rlsOn(r)} NO FORCE ROW LEVEL SECURITY;\n` : ""}${rlsOn(r)} DISABLE ROW LEVEL SECURITY;`;

function planRowSecurity(
  ctx: ObjectsContext,
  phases: ObjectPhases,
  fo: DatabaseObjects,
  to: DatabaseObjects,
): void {
  const key = (r: RowSecurityInfo) => k2(r.schema, r.table);
  const before = byKey(fo.rowSecurity, key);
  const after = byKey(to.rowSecurity, key);
  for (const r of to.rowSecurity) {
    const was = before.get(key(r));
    const object = obj("policy", r.schema, r.table, r.table);
    if (!was) {
      phases.last.push({
        kind: "row_security",
        object,
        up: enableRls(r),
        down: disableRls(r),
        note: `Turns on row-level security for ${r.table}${r.forced ? ", forced for the table's owner too" : ""}.`,
        ...(ctx.createdTables.has(tableKey(r.schema, r.table))
          ? { dependsOnTable: tableKey(r.schema, r.table) }
          : {}),
      });
    } else if (was.forced !== r.forced) {
      phases.last.push({
        kind: "row_security",
        object,
        up: `${rlsOn(r)} ${r.forced ? "FORCE" : "NO FORCE"} ROW LEVEL SECURITY;`,
        down: `${rlsOn(r)} ${was.forced ? "FORCE" : "NO FORCE"} ROW LEVEL SECURITY;`,
        note: `${r.forced ? "Forces" : "Stops forcing"} row-level security on ${r.table} for its owner.`,
      });
    }
  }
  for (const r of fo.rowSecurity) {
    if (after.has(key(r))) continue;
    const tableGoes = ctx.droppedTables.has(tableKey(r.schema, r.table));
    (tableGoes ? phases.dropFirst : phases.last).push({
      kind: "row_security",
      object: obj("policy", r.schema, r.table, r.table),
      up: disableRls(r),
      down: enableRls(r),
      risk: ["destructive"],
      note: `Turns off row-level security for ${r.table}: until it is on again every row is open to whoever can read the table.`,
    });
  }
}
