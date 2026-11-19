/**
 * Plan a migration of tables, columns, constraints, indexes and foreign keys
 * (`docs/migration-studio-plan.md`, sections 3 to 5; the other objects are planned in the next
 * milestone). `planMigration(from, to)` returns the steps that make `from` look like `to`, in the
 * order they must run, each with its reverse and its risk.
 *
 * ORDER (the up script):
 *   1. drop the foreign keys that go, change, or hang on a key or a column that does,
 *   2. drop the other constraints and the indexes that go or change,
 *   3. drop the tables that go,
 *   4. create the new tables (columns only),
 *   5. change the columns of the tables that stay (drop, add, alter),
 *   6. add the constraints and create the indexes of the new and changed,
 *   7. add the foreign keys, last, so two tables that point at each other work.
 * The down script is the steps in reverse, so a table that was dropped is back before the foreign
 * key that pointed at it.
 *
 * Nothing is matched by position or by guess: tables, columns, constraints and indexes are matched
 * by name (a rename is a drop and an add until a person confirms otherwise, milestone M3), and a
 * constraint or an index is "changed" when the text PostgreSQL printed for it changed. No
 * statement contains `CASCADE`.
 */
import type { ColumnDdl, DdlDetail } from "../ddl.js";
import type { ConstraintInfo, IndexInfo, RelationshipInfo } from "../models.js";
import type { DatabaseStructure, StructureTable } from "../structure.js";
import { classifyTypeChange } from "./classify.js";
import { columnSql, collationSql, commentOn, q, qualified, VOLATILE_DEFAULT } from "./sql.js";
import type {
  MigrationPlan,
  MigrationStep,
  PlanOptions,
  Reversibility,
  Risk,
  StepKind,
  StepObject,
} from "./types.js";

const SEP = "\u0001";
const tableKey = (schema: string, name: string): string => `${schema}${SEP}${name}`;

/** What a step is made of, before it has an id. */
interface Draft {
  kind: StepKind;
  object: StepObject;
  up: string;
  down: string | null;
  risk?: Risk[];
  reversibility?: Reversibility;
  transactional?: boolean;
  dependsOn?: string[];
  note: string;
}

/** The statements of the scripts of a plan. */
export function upScript(plan: MigrationPlan): string {
  return plan.steps.map((s) => s.up).join("\n");
}
export function downScript(plan: MigrationPlan): string {
  return [...plan.steps]
    .reverse()
    .map((s) => s.down)
    .filter((d): d is string => d !== null)
    .join("\n");
}

const NOT_COMPARED = [
  "views, materialized views, functions, triggers, row-level security policies, types, sequences, extensions and schemas (planned in a later milestone of this release)",
  "partitioning, inheritance, unlogged tables and storage options",
  "owners, grants and default privileges",
  "event triggers, publications, subscriptions, foreign data wrappers and servers, collations, casts and rules",
  "any row of data: a migration holds structure, not data",
];

interface Side {
  tables: Map<string, StructureTable>;
  ddl: DdlDetail | null;
  columnDdl: Map<string, ColumnDdl>;
  relationships: Map<string, RelationshipInfo>;
  comments: Map<string, string>;
}

const columnKey = (schema: string, table: string, column: string): string =>
  `${schema}${SEP}${table}${SEP}${column}`;

function side(structure: DatabaseStructure): Side {
  const tables = new Map<string, StructureTable>();
  for (const t of structure.tables)
    if (t.kind === "table") tables.set(tableKey(t.schema, t.name), t);
  const columnDdl = new Map<string, ColumnDdl>();
  const comments = new Map<string, string>();
  for (const c of structure.ddl?.columns ?? []) {
    columnDdl.set(columnKey(c.schema, c.table, c.column), c);
  }
  for (const c of structure.ddl?.comments ?? []) {
    if (c.target === "index" || c.target === "constraint") {
      comments.set(`${c.target}${SEP}${c.schema}${SEP}${c.table ?? ""}${SEP}${c.name}`, c.comment);
    }
  }
  const relationships = new Map<string, RelationshipInfo>();
  for (const r of structure.relationships) {
    relationships.set(`${r.source.schema}${SEP}${r.source.table}${SEP}${r.name}`, r);
  }
  return { tables, ddl: structure.ddl, columnDdl, relationships, comments };
}

const byName = <T extends { name: string }>(list: readonly T[]): Map<string, T> =>
  new Map(list.map((item) => [item.name, item]));

const isForeignKey = (c: ConstraintInfo): boolean => c.kind === "foreign_key";
const withoutNotValid = (definition: string): string => definition.replace(/\s+NOT VALID$/, "");
/** The same constraint, added without checking before and checked now (its text lost only `NOT VALID`). */
const becameValid = (before: string | null, after: string | null): boolean =>
  before !== null && after !== null && before !== after && withoutNotValid(before) === after;

/** Does this index belong to a constraint (a primary key or a unique one), which creates it? */
function backedByConstraint(index: IndexInfo, constraints: readonly ConstraintInfo[]): boolean {
  return index.primary || constraints.some((c) => c.name === index.name && c.kind !== "check");
}

export function planMigration(
  from: DatabaseStructure,
  to: DatabaseStructure,
  options: PlanOptions = {},
): MigrationPlan {
  const a = side(from);
  const b = side(to);
  const notCompared = [...NOT_COMPARED];
  const warnings: string[] = [];
  if (a.ddl === null || b.ddl === null) {
    notCompared.push(
      `identity, generated columns, collations, comments on indexes and constraints (not recorded in the ${
        a.ddl === null && b.ddl === null
          ? "two structures"
          : a.ddl === null
            ? "structure it starts from"
            : "structure it goes to"
      }: a snapshot from before 1.7.0)`,
    );
  }

  const drafts: Draft[][] = [[], [], [], [], [], [], []];
  const [dropFks, dropRest, dropTables, createTables, alterColumns, addRest, addFks] = drafts as [
    Draft[],
    Draft[],
    Draft[],
    Draft[],
    Draft[],
    Draft[],
    Draft[],
  ];

  const dropped = [...a.tables.keys()].filter((k) => !b.tables.has(k)).sort();
  const created = [...b.tables.keys()].filter((k) => !a.tables.has(k)).sort();
  const common = [...a.tables.keys()].filter((k) => b.tables.has(k)).sort();
  const createdSet = new Set(created);

  // ------------------------------------------------ what forces a foreign key to be re-made
  // A foreign key is dropped, and added again, when it goes or changes, or when the key it points at
  // goes or changes, or when a column of either end changes type.
  const goes = new Set<string>(); // "schema SEP table SEP constraint" dropped for good
  const remade = new Set<string>(); // dropped and added again, unchanged
  const fkKey = (schema: string, table: string, name: string) =>
    `${schema}${SEP}${table}${SEP}${name}`;

  const keyChanged = (schema: string, table: string, columns: readonly string[]): boolean => {
    const before = a.tables.get(tableKey(schema, table));
    const after = b.tables.get(tableKey(schema, table));
    if (!before) return false;
    if (!after) return true;
    const sameColumns = (c: ConstraintInfo) => c.columns.join("\u0002") === columns.join("\u0002");
    const afterByName = byName(after.constraints);
    const lost = before.constraints.some((c) => {
      if (c.kind !== "primary_key" && c.kind !== "unique") return false;
      if (!sameColumns(c)) return false;
      const now = afterByName.get(c.name);
      return !now || now.definition !== c.definition;
    });
    // A unique INDEX (not a constraint) can be the key a foreign key points at.
    const afterIndexes = byName(after.indexes);
    const lostIndex = before.indexes.some((i) => {
      if (!i.unique || backedByConstraint(i, before.constraints)) return false;
      if (i.columns.join("\u0002") !== columns.join("\u0002")) return false;
      const now = afterIndexes.get(i.name);
      return !now || now.definition !== i.definition;
    });
    return lost || lostIndex;
  };
  const typeChanged = (schema: string, table: string, column: string): boolean => {
    const before = a.tables.get(tableKey(schema, table))?.columns.find((c) => c.name === column);
    const after = b.tables.get(tableKey(schema, table))?.columns.find((c) => c.name === column);
    return !!before && !!after && before.dataType !== after.dataType;
  };

  for (const t of a.tables.values()) {
    const after = b.tables.get(tableKey(t.schema, t.name));
    const afterConstraints = after ? byName(after.constraints) : new Map<string, ConstraintInfo>();
    for (const c of t.constraints) {
      if (!isForeignKey(c)) continue;
      const k = fkKey(t.schema, t.name, c.name);
      const now = afterConstraints.get(c.name);
      if (!after || !now || now.definition !== c.definition) {
        // The same text but for NOT VALID goes through VALIDATE, not a drop.
        if (
          after &&
          now &&
          c.definition &&
          now.definition &&
          withoutNotValid(c.definition) === now.definition
        )
          continue;
        goes.add(k);
        continue;
      }
      const rel = a.relationships.get(k);
      if (!rel) continue;
      const pointsAtChangedKey = keyChanged(
        rel.target.schema,
        rel.target.table,
        rel.target.columns,
      );
      const touchesChangedType =
        rel.source.columns.some((col) => typeChanged(rel.source.schema, rel.source.table, col)) ||
        rel.target.columns.some((col) => typeChanged(rel.target.schema, rel.target.table, col));
      // Also: a column of the foreign key that is dropped goes with its table or is dropped itself (then the FK changes too).
      if (pointsAtChangedKey || touchesChangedType) remade.add(k);
    }
  }

  // ------------------------------------------------------------------ 1. drop foreign keys
  const addConstraintSql = (t: StructureTable, c: ConstraintInfo, valid: boolean): string =>
    `ALTER TABLE ${qualified(t.schema, t.name)} ADD CONSTRAINT ${q(c.name)} ${valid ? withoutNotValid(c.definition ?? "") : (c.definition ?? "")};`;
  const dropConstraintSql = (t: StructureTable, name: string): string =>
    `ALTER TABLE ${qualified(t.schema, t.name)} DROP CONSTRAINT ${q(name)};`;

  // A constraint or an index that is dropped takes its comment with it, so what brings it back
  // brings the comment back too.
  type Commented = "constraint" | "index";
  const commentOf = (s: Side, kind: Commented, t: StructureTable, name: string): string | null =>
    s.comments.get(`${kind}${SEP}${t.schema}${SEP}${t.name}${SEP}${name}`) ?? null;
  const commentTarget = (kind: Commented, t: StructureTable, name: string): string =>
    kind === "constraint"
      ? `CONSTRAINT ${q(name)} ON ${qualified(t.schema, t.name)}`
      : `INDEX ${qualified(t.schema, name)}`;
  const withComment = (
    sql: string,
    s: Side,
    kind: Commented,
    t: StructureTable,
    name: string,
  ): string => {
    const comment = commentOf(s, kind, t, name);
    return comment === null ? sql : `${sql}\n${commentOn(commentTarget(kind, t, name), comment)}`;
  };

  for (const t of [...a.tables.values()].sort((x, y) =>
    tableKey(x.schema, x.name).localeCompare(tableKey(y.schema, y.name)),
  )) {
    for (const c of [...t.constraints].sort((x, y) => x.name.localeCompare(y.name))) {
      if (!isForeignKey(c)) continue;
      const k = fkKey(t.schema, t.name, c.name);
      if (!goes.has(k) && !remade.has(k)) continue;
      dropFks.push({
        kind: "drop_constraint",
        object: { schema: t.schema, table: t.name, name: c.name },
        up: dropConstraintSql(t, c.name),
        down: withComment(addConstraintSql(t, c, false), a, "constraint", t, c.name),
        reversibility: "full",
        note: remade.has(k)
          ? `Drops the foreign key ${c.name} of ${t.name} for a moment: the key or the column it depends on changes.`
          : `Drops the foreign key ${c.name} of ${t.name}.`,
      });
    }
  }

  // ------------------------------------------------- 2. drop other constraints and indexes
  const droppedConstraints = new Set<string>();
  for (const key of common) {
    const before = a.tables.get(key)!;
    const after = b.tables.get(key)!;
    const afterConstraints = byName(after.constraints);
    const afterIndexes = byName(after.indexes);
    const obj = (name: string): StepObject => ({ schema: before.schema, table: before.name, name });
    for (const c of [...before.constraints].sort((x, y) => x.name.localeCompare(y.name))) {
      if (isForeignKey(c)) continue;
      const now = afterConstraints.get(c.name);
      if (now && now.definition === c.definition) continue;
      if (now && c.definition && now.definition && withoutNotValid(c.definition) === now.definition)
        continue;
      droppedConstraints.add(`${key}${SEP}${c.name}`);
      dropRest.push({
        kind: "drop_constraint",
        object: obj(c.name),
        up: dropConstraintSql(before, c.name),
        down: withComment(addConstraintSql(before, c, false), a, "constraint", before, c.name),
        reversibility: "full",
        note: `Drops the ${c.kind.replace("_", " ")} constraint ${c.name} of ${before.name}${now ? " (it changes)" : ""}.`,
      });
    }
    for (const i of [...before.indexes].sort((x, y) => x.name.localeCompare(y.name))) {
      if (backedByConstraint(i, before.constraints)) continue;
      const now = afterIndexes.get(i.name);
      if (now && now.definition === i.definition) continue;
      dropRest.push({
        kind: "drop_index",
        object: obj(i.name),
        up: `DROP INDEX ${qualified(before.schema, i.name)};`,
        down: withComment(`${i.definition ?? ""};`, a, "index", before, i.name),
        reversibility: "full",
        note: `Drops the index ${i.name} of ${before.name}${now ? " (it changes)" : ""}.`,
      });
    }
  }

  // ----------------------------------------------------------------- 3. drop tables
  const createTableSql = (t: StructureTable, ddl: Side): string => {
    const cols = [...t.columns]
      .sort((x, y) => x.ordinalPosition - y.ordinalPosition)
      .map((c) => `  ${columnSql(c, ddl.columnDdl.get(columnKey(t.schema, t.name, c.name)))}`);
    return `CREATE TABLE ${qualified(t.schema, t.name)} (\n${cols.join(",\n")}\n);`;
  };
  /** The statements that bring back a table with everything but its foreign keys. */
  const recreateSql = (t: StructureTable, s: Side): string => {
    const lines = [createTableSql(t, s)];
    for (const c of [...t.constraints].sort((x, y) => x.name.localeCompare(y.name))) {
      if (!isForeignKey(c))
        lines.push(withComment(addConstraintSql(t, c, false), s, "constraint", t, c.name));
    }
    for (const i of [...t.indexes].sort((x, y) => x.name.localeCompare(y.name))) {
      if (!backedByConstraint(i, t.constraints)) lines.push(`${i.definition ?? ""};`);
      const comment = commentOf(s, "index", t, i.name);
      if (comment !== null) lines.push(commentOn(commentTarget("index", t, i.name), comment));
    }
    if (t.comment !== null)
      lines.push(commentOn(`TABLE ${qualified(t.schema, t.name)}`, t.comment));
    for (const c of t.columns) {
      if (c.comment !== null) {
        lines.push(commentOn(`COLUMN ${qualified(t.schema, t.name)}.${q(c.name)}`, c.comment));
      }
    }
    return lines.join("\n");
  };
  for (const key of dropped) {
    const t = a.tables.get(key)!;
    dropTables.push({
      kind: "drop_table",
      object: { schema: t.schema, table: t.name },
      up: `DROP TABLE ${qualified(t.schema, t.name)};`,
      down: recreateSql(t, a),
      risk: ["destructive"],
      reversibility: "data_lost",
      note: `Drops the table ${t.name} and every row in it. The rollback makes the table again, empty.`,
    });
  }

  // --------------------------------------------------------------- 4. create tables
  for (const key of created) {
    const t = b.tables.get(key)!;
    createTables.push({
      kind: "create_table",
      object: { schema: t.schema, table: t.name },
      up: createTableSql(t, b),
      down: `DROP TABLE ${qualified(t.schema, t.name)};`,
      reversibility: "full",
      note: `Creates the table ${t.name} with ${t.columns.length} column${t.columns.length === 1 ? "" : "s"}.`,
    });
    for (const c of t.columns) {
      if (c.defaultValue !== null && /\bnextval\s*\(/i.test(c.defaultValue)) {
        warnings.push(
          `${t.name}.${c.name} takes its default from a sequence (${c.defaultValue}). Sequences are planned in a later milestone: create the sequence first.`,
        );
      }
    }
  }

  // ---------------------------------------------------------- 5. change columns
  const alterTable = (t: StructureTable) => `ALTER TABLE ${qualified(t.schema, t.name)}`;
  for (const key of common) {
    const before = a.tables.get(key)!;
    const after = b.tables.get(key)!;
    const obj = (column: string): StepObject => ({
      schema: after.schema,
      table: after.name,
      column,
    });
    const beforeCols = byName(before.columns);
    const afterCols = byName(after.columns);
    const detail = (s: Side, t: StructureTable, c: string) =>
      s.columnDdl.get(columnKey(t.schema, t.name, c));

    // A column that is generated, or becomes or stops being generated, is dropped and added again:
    // an expression is not altered in place.
    const regenerated = new Set<string>();
    for (const [name, now] of afterCols) {
      const was = beforeCols.get(name);
      if (!was) continue;
      const dBefore = detail(a, before, name);
      const dAfter = detail(b, after, name);
      const genBefore = dBefore?.generated ?? null;
      const genAfter = dAfter?.generated ?? null;
      if (genBefore !== genAfter || (genAfter !== null && was.defaultValue !== now.defaultValue)) {
        regenerated.add(name);
      }
    }

    const removed = [...beforeCols.values()].filter(
      (c) => !afterCols.has(c.name) || regenerated.has(c.name),
    );
    const added = [...afterCols.values()].filter(
      (c) => !beforeCols.has(c.name) || regenerated.has(c.name),
    );
    for (const c of removed.sort((x, y) => x.name.localeCompare(y.name))) {
      alterColumns.push({
        kind: "drop_column",
        object: obj(c.name),
        up: `${alterTable(before)} DROP COLUMN ${q(c.name)};`,
        down: `${alterTable(before)} ADD COLUMN ${columnSql(c, detail(a, before, c.name))};${
          c.comment === null
            ? ""
            : `\n${commentOn(`COLUMN ${qualified(before.schema, before.name)}.${q(c.name)}`, c.comment)}`
        }`,
        risk: ["lock", "destructive"],
        reversibility: "data_lost",
        note: `Drops the column ${c.name} of ${before.name} and the values in it.${
          !c.nullable && c.defaultValue === null
            ? " The rollback adds it back, which fails if the table has rows."
            : " The rollback adds it back, empty."
        }`,
      });
    }
    for (const c of added.sort((x, y) => x.ordinalPosition - y.ordinalPosition)) {
      const d = detail(b, after, c.name);
      const risk: Risk[] = ["lock"];
      if (!c.nullable && c.defaultValue === null && !d?.identity && !d?.generated)
        risk.push("may_fail");
      if (
        d?.identity ||
        d?.generated === "stored" ||
        (c.defaultValue !== null && VOLATILE_DEFAULT.test(c.defaultValue))
      ) {
        risk.push("rewrite");
      }
      if (c.defaultValue !== null && /\bnextval\s*\(/i.test(c.defaultValue) && !d?.generated) {
        warnings.push(
          `${after.name}.${c.name} takes its default from a sequence (${c.defaultValue}). Sequences are planned in a later milestone: create the sequence first.`,
        );
      }
      alterColumns.push({
        kind: "add_column",
        object: obj(c.name),
        up: `${alterTable(after)} ADD COLUMN ${columnSql(c, d)};`,
        down: `${alterTable(after)} DROP COLUMN ${q(c.name)};`,
        risk,
        reversibility: "full",
        note: `Adds the column ${c.name} to ${after.name}.${
          risk.includes("may_fail")
            ? " It fails if the table has rows (a NOT NULL column with no default)."
            : ""
        }`,
      });
    }

    for (const name of [...afterCols.keys()].sort()) {
      const was = beforeCols.get(name);
      const now = afterCols.get(name)!;
      if (!was || regenerated.has(name)) continue;
      const dBefore = detail(a, before, name);
      const dAfter = detail(b, after, name);
      const col = q(name);
      const tbl = alterTable(after);

      const idBefore = dBefore?.identity ?? null;
      const idAfter = dAfter?.identity ?? null;
      const collBefore = dBefore?.collation ?? null;
      const collAfter = dAfter?.collation ?? null;
      const typeDiffers = was.dataType !== now.dataType;
      const collDiffers = collBefore !== collAfter;
      const defaultBecomesIdentity =
        idAfter !== null && idBefore === null && was.defaultValue !== null;

      // 1. drop identity (and nothing else about it)
      if (idBefore !== null && idAfter === null) {
        alterColumns.push({
          kind: "drop_identity",
          object: obj(name),
          up: `${tbl} ALTER COLUMN ${col} DROP IDENTITY;`,
          down: `${tbl} ALTER COLUMN ${col} ADD GENERATED ${idBefore === "always" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY;`,
          reversibility: "full",
          note: `${name} of ${after.name} stops being an identity column.`,
        });
      }
      // 2. drop a default that goes (or that an identity replaces)
      if (
        (was.defaultValue !== null && now.defaultValue === null && idBefore === null) ||
        defaultBecomesIdentity
      ) {
        alterColumns.push({
          kind: "drop_default",
          object: obj(name),
          up: `${tbl} ALTER COLUMN ${col} DROP DEFAULT;`,
          down: `${tbl} ALTER COLUMN ${col} SET DEFAULT ${was.defaultValue};`,
          reversibility: "full",
          note: `Drops the default of ${name} of ${after.name}.`,
        });
      }
      // 3. type and collation, in one statement
      if (typeDiffers || collDiffers) {
        const change = typeDiffers
          ? classifyTypeChange(was.dataType, now.dataType)
          : { risk: ["lock", "rewrite"] as Risk[], using: false, note: null };
        const back = typeDiffers
          ? classifyTypeChange(now.dataType, was.dataType)
          : { risk: [] as Risk[], using: false, note: null };
        const target = `${now.dataType}${collAfter ? ` COLLATE ${collationSql(collAfter)}` : ""}`;
        const source = `${was.dataType}${collBefore ? ` COLLATE ${collationSql(collBefore)}` : ""}`;
        const lossy = change.risk.includes("destructive");
        alterColumns.push({
          kind: "alter_column_type",
          object: obj(name),
          up: `${tbl} ALTER COLUMN ${col} TYPE ${target}${change.using ? ` USING ${col}::${now.dataType}` : ""};`,
          down: `${tbl} ALTER COLUMN ${col} TYPE ${source}${back.using ? ` USING ${col}::${was.dataType}` : ""};`,
          risk: change.risk,
          reversibility: lossy ? "data_lost" : "full",
          note: `Changes the type of ${name} of ${after.name} from ${was.dataType}${collBefore ? ` (collation ${collBefore})` : ""} to ${now.dataType}${collAfter ? ` (collation ${collAfter})` : ""}.${change.note ? ` ${change.note}` : ""}`,
        });
      }
      // 4. nullability
      if (was.nullable !== now.nullable) {
        alterColumns.push(
          now.nullable
            ? {
                kind: "drop_not_null",
                object: obj(name),
                up: `${tbl} ALTER COLUMN ${col} DROP NOT NULL;`,
                down: `${tbl} ALTER COLUMN ${col} SET NOT NULL;`,
                reversibility: "full",
                note: `${name} of ${after.name} may be NULL. The rollback sets NOT NULL again, which fails if a NULL was stored since.`,
              }
            : {
                kind: "set_not_null",
                object: obj(name),
                up: `${tbl} ALTER COLUMN ${col} SET NOT NULL;`,
                down: `${tbl} ALTER COLUMN ${col} DROP NOT NULL;`,
                risk: ["lock", "may_fail"],
                reversibility: "full",
                note: `${name} of ${after.name} may not be NULL. It fails if a row holds NULL there.`,
              },
        );
      }
      // 5. identity added or its kind changed
      if (idAfter !== null && idBefore === null) {
        alterColumns.push({
          kind: "add_identity",
          object: obj(name),
          up: `${tbl} ALTER COLUMN ${col} ADD GENERATED ${idAfter === "always" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY;`,
          down: `${tbl} ALTER COLUMN ${col} DROP IDENTITY;`,
          reversibility: "full",
          note: `${name} of ${after.name} becomes an identity column.`,
        });
      } else if (idAfter !== null && idBefore !== null && idAfter !== idBefore) {
        alterColumns.push({
          kind: "set_identity",
          object: obj(name),
          up: `${tbl} ALTER COLUMN ${col} SET GENERATED ${idAfter === "always" ? "ALWAYS" : "BY DEFAULT"};`,
          down: `${tbl} ALTER COLUMN ${col} SET GENERATED ${idBefore === "always" ? "ALWAYS" : "BY DEFAULT"};`,
          reversibility: "full",
          note: `The identity of ${name} of ${after.name} is ${idAfter === "always" ? "always" : "by default"}.`,
        });
      }
      // 6. a default that is set or changed
      if (now.defaultValue !== null && now.defaultValue !== was.defaultValue && idAfter === null) {
        alterColumns.push({
          kind: "set_default",
          object: obj(name),
          up: `${tbl} ALTER COLUMN ${col} SET DEFAULT ${now.defaultValue};`,
          down:
            was.defaultValue === null
              ? `${tbl} ALTER COLUMN ${col} DROP DEFAULT;`
              : `${tbl} ALTER COLUMN ${col} SET DEFAULT ${was.defaultValue};`,
          reversibility: "full",
          note: `Sets the default of ${name} of ${after.name}. Rows that exist keep their value.`,
        });
      }
    }
    // Comments on columns and on the table.
    for (const name of [...afterCols.keys()].sort()) {
      const was = beforeCols.get(name);
      const now = afterCols.get(name)!;
      // A column made in this plan (new, or dropped and made again) has no comment yet; dropping it
      // again takes the comment with it, so such a comment has no step of its own to undo.
      const made = !was || regenerated.has(name);
      if (made ? now.comment === null : was.comment === now.comment) continue;
      alterColumns.push({
        kind: "comment_column",
        object: obj(name),
        up: commentOn(`COLUMN ${qualified(after.schema, after.name)}.${q(name)}`, now.comment),
        down: made
          ? null
          : commentOn(`COLUMN ${qualified(after.schema, after.name)}.${q(name)}`, was.comment),
        reversibility: "full",
        note: `${made ? "Comments" : "Changes the comment on"} ${name} of ${after.name}.`,
      });
    }
    if (before.comment !== after.comment) {
      alterColumns.push({
        kind: "comment_table",
        object: { schema: after.schema, table: after.name },
        up: commentOn(`TABLE ${qualified(after.schema, after.name)}`, after.comment),
        down: commentOn(`TABLE ${qualified(after.schema, after.name)}`, before.comment),
        reversibility: "full",
        note: `Changes the comment on the table ${after.name}.`,
      });
    }
  }
  // Comments of columns and of the table of a table that was created.
  for (const key of created) {
    const t = b.tables.get(key)!;
    if (t.comment !== null) {
      createTables.push({
        kind: "comment_table",
        object: { schema: t.schema, table: t.name },
        up: commentOn(`TABLE ${qualified(t.schema, t.name)}`, t.comment),
        down: null,
        reversibility: "full",
        dependsOnTable: key,
        note: `Comments the table ${t.name}.`,
      } as Draft & { dependsOnTable: string });
    }
    for (const c of t.columns) {
      if (c.comment === null) continue;
      createTables.push({
        kind: "comment_column",
        object: { schema: t.schema, table: t.name, column: c.name },
        up: commentOn(`COLUMN ${qualified(t.schema, t.name)}.${q(c.name)}`, c.comment),
        down: null,
        reversibility: "full",
        dependsOnTable: key,
        note: `Comments the column ${c.name} of ${t.name}.`,
      } as Draft & { dependsOnTable: string });
    }
  }

  // -------------------------------------- 6. add constraints and create indexes
  const wantsSafe = options.safeConstraints === true;
  const touched = [...created, ...common];
  for (const key of touched) {
    const before = a.tables.get(key);
    const after = b.tables.get(key)!;
    const isNew = createdSet.has(key);
    const beforeConstraints = before
      ? byName(before.constraints)
      : new Map<string, ConstraintInfo>();
    const beforeIndexes = before ? byName(before.indexes) : new Map<string, IndexInfo>();
    const obj = (name: string): StepObject => ({ schema: after.schema, table: after.name, name });
    const depends = isNew ? { dependsOnTable: key } : {};

    for (const c of [...after.constraints].sort((x, y) => x.name.localeCompare(y.name))) {
      if (isForeignKey(c)) continue;
      const was = beforeConstraints.get(c.name);
      if (was && was.definition === c.definition) continue;
      if (becameValid(was?.definition ?? null, c.definition)) {
        // Added without checking, now checked.
        addRest.push({
          kind: "validate_constraint",
          object: obj(c.name),
          up: `${alterTable(after)} VALIDATE CONSTRAINT ${q(c.name)};`,
          down: null,
          risk: ["may_fail"],
          reversibility: "none",
          note: `Checks the existing rows against ${c.name} of ${after.name}. It cannot be undone: a constraint stays checked.`,
        });
        continue;
      }
      const risk: Risk[] = isNew ? [] : ["lock", "may_fail"];
      const split =
        wantsSafe && !isNew && c.kind === "check" && !/NOT VALID$/.test(c.definition ?? "");
      addRest.push({
        kind: "add_constraint",
        object: obj(c.name),
        up: split
          ? `${alterTable(after)} ADD CONSTRAINT ${q(c.name)} ${c.definition ?? ""} NOT VALID;`
          : addConstraintSql(after, c, false),
        down: dropConstraintSql(after, c.name),
        risk: split ? ["lock"] : risk,
        reversibility: "full",
        note: `Adds the ${c.kind.replace("_", " ")} constraint ${c.name} to ${after.name}.${isNew ? "" : " It fails if a row breaks it."}`,
        ...depends,
      } as Draft);
      if (split) {
        addRest.push({
          kind: "validate_constraint",
          object: obj(c.name),
          up: `${alterTable(after)} VALIDATE CONSTRAINT ${q(c.name)};`,
          down: null,
          risk: ["may_fail"],
          reversibility: "full",
          note: `Checks the existing rows against ${c.name}. It does not block writes while it scans.`,
        });
      }
    }
    for (const i of [...after.indexes].sort((x, y) => x.name.localeCompare(y.name))) {
      if (backedByConstraint(i, after.constraints)) continue;
      const was = beforeIndexes.get(i.name);
      if (was && was.definition === i.definition) continue;
      const concurrent = options.concurrentIndexes === true && !isNew;
      const definition = i.definition ?? "";
      const text = concurrent
        ? definition.replace(/^CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX CONCURRENTLY ")
        : definition;
      addRest.push({
        kind: "create_index",
        object: obj(i.name),
        up: `${text};`,
        down: `DROP INDEX ${qualified(after.schema, i.name)};`,
        risk: [
          ...(isNew || concurrent ? [] : (["lock"] as Risk[])),
          ...(i.unique && !isNew ? (["may_fail"] as Risk[]) : []),
        ],
        reversibility: "full",
        transactional: !concurrent,
        note: `Creates the ${i.unique ? "unique " : ""}index ${i.name} on ${after.name}.${concurrent ? " It is made without blocking writes, so it cannot run inside a transaction." : ""}`,
        ...depends,
      } as Draft);
    }
    // Comments on constraints and indexes (recorded in the detail). Something made in this plan
    // (new, or dropped and added again) starts with no comment, and dropping it again takes the
    // comment with it, so only a comment to set is needed, with nothing to undo.
    const constraintMade = (c: ConstraintInfo): boolean => {
      const was = beforeConstraints.get(c.name);
      return (
        !was ||
        was.definition !== c.definition ||
        remade.has(fkKey(after.schema, after.name, c.name))
      );
    };
    const madeConstraints = new Set(after.constraints.filter(constraintMade).map((c) => c.name));
    const indexMade = (i: IndexInfo): boolean => {
      if (backedByConstraint(i, after.constraints)) return madeConstraints.has(i.name);
      const was = beforeIndexes.get(i.name);
      return !was || was.definition !== i.definition;
    };
    const items: { kind: Commented; name: string; made: boolean; fk: boolean }[] = [
      ...after.constraints.map((c) => ({
        kind: "constraint" as const,
        name: c.name,
        made: madeConstraints.has(c.name),
        fk: isForeignKey(c),
      })),
      ...after.indexes.map((i) => ({
        kind: "index" as const,
        name: i.name,
        made: indexMade(i),
        fk: false,
      })),
    ];
    for (const item of items.sort((x, y) => x.name.localeCompare(y.name))) {
      // A foreign key made in this plan is commented in step 7, after it exists.
      if (item.fk && item.made) continue;
      const { kind, name, made } = item;
      const k = `${kind}${SEP}${after.schema}${SEP}${after.name}${SEP}${name}`;
      const now = b.comments.get(k) ?? null;
      const was =
        a.ddl === null || b.ddl === null ? now : made ? null : (a.comments.get(k) ?? null);
      if (now === was) continue;
      addRest.push({
        kind: kind === "constraint" ? "comment_constraint" : "comment_index",
        object: obj(name),
        up: commentOn(commentTarget(kind, after, name), now),
        down: made ? null : commentOn(commentTarget(kind, after, name), was),
        reversibility: "full",
        note: `${made ? "Comments" : "Changes the comment on"} the ${kind} ${name}.`,
        ...(isNew ? { dependsOnTable: key } : {}),
      } as Draft);
    }
  }

  // ------------------------------------------------------------ 7. add foreign keys
  for (const key of touched) {
    const before = a.tables.get(key);
    const after = b.tables.get(key)!;
    const isNew = createdSet.has(key);
    const beforeConstraints = before
      ? byName(before.constraints)
      : new Map<string, ConstraintInfo>();
    for (const c of [...after.constraints].sort((x, y) => x.name.localeCompare(y.name))) {
      if (!isForeignKey(c)) continue;
      const k = fkKey(after.schema, after.name, c.name);
      const was = beforeConstraints.get(c.name);
      const isRemade = remade.has(k);
      if (was && was.definition === c.definition && !isRemade) continue;
      if (becameValid(was?.definition ?? null, c.definition)) {
        addFks.push({
          kind: "validate_constraint",
          object: { schema: after.schema, table: after.name, name: c.name },
          up: `${alterTable(after)} VALIDATE CONSTRAINT ${q(c.name)};`,
          down: null,
          risk: ["may_fail"],
          reversibility: "none",
          note: `Checks the existing rows against the foreign key ${c.name}. It cannot be undone.`,
        });
        continue;
      }
      const split = wantsSafe && !isNew && !/NOT VALID$/.test(c.definition ?? "");
      const rel = b.relationships.get(k);
      const needs: Record<string, string> = {};
      if (isNew) needs.dependsOnTable = key;
      if (rel && createdSet.has(tableKey(rel.target.schema, rel.target.table))) {
        needs.alsoDependsOnTable = tableKey(rel.target.schema, rel.target.table);
      }
      addFks.push({
        kind: "add_constraint",
        object: { schema: after.schema, table: after.name, name: c.name },
        up: split
          ? `${alterTable(after)} ADD CONSTRAINT ${q(c.name)} ${c.definition ?? ""} NOT VALID;`
          : addConstraintSql(after, c, false),
        down: dropConstraintSql(after, c.name),
        risk: isNew && !isRemade ? [] : split ? ["lock"] : ["lock", "may_fail"],
        reversibility: "full",
        note: `Adds the foreign key ${c.name} to ${after.name}.${isRemade ? " It is made again because the key or the column it depends on changes." : isNew ? "" : " It fails if a row breaks it."}`,
        ...needs,
      } as Draft);
      if (split) {
        addFks.push({
          kind: "validate_constraint",
          object: { schema: after.schema, table: after.name, name: c.name },
          up: `${alterTable(after)} VALIDATE CONSTRAINT ${q(c.name)};`,
          down: null,
          risk: ["may_fail"],
          reversibility: "full",
          note: `Checks the existing rows against the foreign key ${c.name}. It does not block writes while it scans.`,
        });
      }
      const fkComment =
        b.comments.get(`constraint${SEP}${after.schema}${SEP}${after.name}${SEP}${c.name}`) ?? null;
      if (fkComment !== null && b.ddl !== null) {
        addFks.push({
          kind: "comment_constraint",
          object: { schema: after.schema, table: after.name, name: c.name },
          up: commentOn(commentTarget("constraint", after, c.name), fkComment),
          down: null,
          reversibility: "full",
          note: `Comments the foreign key ${c.name}.`,
        });
      }
    }
  }

  // Differences this plan cannot make: said, not skipped silently.
  if (a.ddl && b.ddl) {
    const tableDdl = (d: DdlDetail) =>
      new Map(d.tables.map((t) => [tableKey(t.schema, t.name), JSON.stringify(t)]));
    const x = tableDdl(a.ddl);
    const y = tableDdl(b.ddl);
    for (const key of common) {
      if ((x.get(key) ?? "") !== (y.get(key) ?? "")) {
        const t = b.tables.get(key)!;
        warnings.push(
          `${t.name} differs in partitioning, inheritance, being unlogged or its storage options. The plan does not change those yet.`,
        );
      }
    }
  }
  // A view that reads a table whose column goes or changes type: PostgreSQL refuses.
  const viewsOf = (s: DatabaseStructure) => s.objects?.views ?? [];
  for (const key of common) {
    const before = a.tables.get(key)!;
    const after = b.tables.get(key)!;
    const afterCols = byName(after.columns);
    const risky = before.columns.filter((c) => {
      const now = afterCols.get(c.name);
      return !now || now.dataType !== c.dataType;
    });
    if (risky.length === 0) continue;
    for (const view of viewsOf(from)) {
      if (view.dependsOn.some((d) => d.schema === before.schema && d.name === before.name)) {
        warnings.push(
          `The view ${view.name} reads ${before.name}. PostgreSQL refuses to drop or retype a column the view uses (${risky.map((c) => c.name).join(", ")}): the view has to be dropped and made again, which this plan does not do yet.`,
        );
      }
    }
  }

  // ------------------------------------------------------------------ numbering
  const steps: MigrationStep[] = [];
  const idOfCreate = new Map<string, string>();
  let n = 0;
  for (const [phase, group] of drafts.entries()) {
    for (const d of group) {
      const extra = d as Draft & { dependsOnTable?: string; alsoDependsOnTable?: string };
      const id = `s${++n}`;
      const dependsOn: string[] = [...(d.dependsOn ?? [])];
      for (const tk of [extra.dependsOnTable, extra.alsoDependsOnTable]) {
        const created = tk ? idOfCreate.get(tk) : undefined;
        if (created) dependsOn.push(created);
      }
      if (d.kind === "create_table") idOfCreate.set(tableKey(d.object.schema, d.object.table), id);
      steps.push({
        id,
        kind: d.kind,
        object: d.object,
        up: d.up,
        down: d.down,
        risk: d.risk ?? [],
        reversibility: d.reversibility ?? (d.down === null ? "none" : "full"),
        transactional: d.transactional ?? true,
        dependsOn,
        note: d.note,
      });
      void phase;
    }
  }
  const reversibility: MigrationPlan["reversibility"] =
    steps.length === 0 || steps.every((s) => s.reversibility === "full")
      ? "full"
      : steps.every((s) => s.reversibility === "none")
        ? "none"
        : "partial";
  return { steps, reversibility, notCompared, warnings: [...new Set(warnings)] };
}
