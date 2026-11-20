/**
 * Property check for the migration planner: small random databases as `from`, a few random changes
 * to make `to`, and the plan must pass the round trip on a real PostgreSQL (up makes `from` equal
 * `to`; down makes it equal `from`). A failure prints the seed and both databases as SQL, so it can
 * be replayed with `DATACANVAS_PROPERTY_SEED=<seed>`.
 *
 * `DATACANVAS_PROPERTY_RUNS` sets how many pairs (default 40). No rows: a change that needs rows to
 * go wrong is the business of the scenario tests, this is about order and completeness.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPair, disposePair, runPlanScenario, type Pair } from "./testing/round-trip.js";
import { testDatabaseUrl } from "./testing/index.js";

// ----------------------------------------------------------------------------- random

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Random {
  constructor(private readonly next: () => number) {}
  int(max: number): number {
    return Math.floor(this.next() * max);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)]!;
  }
}

// ------------------------------------------------------------------------------ model

interface Column {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  comment: string | null;
}
interface Table {
  name: string;
  columns: Column[];
  uniques: string[];
  checks: string[];
  indexes: string[];
  /** Column names that are foreign keys to `<ref>.id`; the column is `ref_<ref>`. */
  fks: string[];
  comment: string | null;
}
interface View {
  name: string;
  table: string;
  columns: string[];
}
interface Model {
  tables: Table[];
  views: View[];
}

const TYPES = ["integer", "bigint", "text", "varchar(20)", "numeric(10,2)", "boolean"];
const DEFAULTS: Record<string, string[]> = {
  integer: ["0", "5"],
  bigint: ["0", "7"],
  text: ["'x'", "''"],
  "varchar(20)": ["'y'"],
  "numeric(10,2)": ["1.50", "0"],
  boolean: ["true", "false"],
};
/** Changes of type that PostgreSQL can make on a table with no rows (some need USING, which the plan writes). */
const RETYPES: Record<string, string[]> = {
  integer: ["bigint", "numeric(10,2)", "text"],
  bigint: ["numeric(10,2)", "text"],
  text: ["varchar(20)", "integer"],
  "varchar(20)": ["text"],
  "numeric(10,2)": ["text"],
  boolean: ["text"],
};

const tableNames = ["t1", "t2", "t3", "t4"];
const columnNames = ["c1", "c2", "c3", "c4", "c5", "c6"];

const isNumeric = (t: string) => ["integer", "bigint", "numeric(10,2)"].includes(t);

function newColumn(r: Random, taken: Set<string>): Column | null {
  const free = columnNames.filter((n) => !taken.has(n));
  if (free.length === 0) return null;
  const type = r.pick(TYPES);
  return {
    name: r.pick(free),
    type,
    notNull: r.chance(0.3),
    default: r.chance(0.4) ? r.pick(DEFAULTS[type]!) : null,
    comment: r.chance(0.2) ? "a comment" : null,
  };
}

function newTable(r: Random, name: string): Table {
  const columns: Column[] = [];
  const taken = new Set<string>();
  for (let i = r.int(3) + 1; i > 0; i--) {
    const c = newColumn(r, taken);
    if (c) {
      columns.push(c);
      taken.add(c.name);
    }
  }
  const table: Table = {
    name,
    columns,
    uniques: [],
    checks: [],
    indexes: [],
    fks: [],
    comment: r.chance(0.2) ? "a table" : null,
  };
  for (const c of columns) decorate(r, table, c);
  return table;
}

/** Maybe a unique, a check and an index on a column. */
function decorate(r: Random, t: Table, c: Column): void {
  if (r.chance(0.2) && c.type !== "boolean") t.uniques.push(c.name);
  if (r.chance(0.2) && (isNumeric(c.type) || c.type === "text" || c.type === "varchar(20)"))
    t.checks.push(c.name);
  if (r.chance(0.25)) t.indexes.push(c.name);
}

function generate(r: Random): Model {
  const model: Model = { tables: [], views: [] };
  const count = r.int(3) + 1;
  for (const name of tableNames.slice(0, count)) model.tables.push(newTable(r, name));
  for (const t of model.tables) if (r.chance(0.3)) addFk(r, model, t);
  for (const t of model.tables) if (r.chance(0.3)) addView(r, model, t);
  return model;
}

function addFk(r: Random, model: Model, t: Table): void {
  const targets = model.tables.filter((x) => x.name !== t.name);
  if (targets.length === 0) return;
  const target = r.pick(targets);
  const name = `ref_${target.name}`;
  if (t.columns.some((c) => c.name === name)) return;
  t.columns.push({ name, type: "integer", notNull: false, default: null, comment: null });
  t.fks.push(name);
}

function addView(r: Random, model: Model, t: Table): void {
  if (model.views.some((v) => v.table === t.name)) return;
  const cols = t.columns.filter(() => r.chance(0.6)).map((c) => c.name);
  model.views.push({ name: `v_${t.name}`, table: t.name, columns: cols });
}

/** A change that keeps the model consistent (a column that goes takes what names it along). */
function mutate(r: Random, model: Model): void {
  const t = model.tables.length > 0 ? r.pick(model.tables) : undefined;
  const ops = [
    "addTable",
    "dropTable",
    "addColumn",
    "dropColumn",
    "retype",
    "notNull",
    "default",
    "addIndex",
    "dropIndex",
    "addUnique",
    "dropUnique",
    "addCheck",
    "dropCheck",
    "addFk",
    "dropFk",
    "addView",
    "changeView",
    "dropView",
    "comment",
  ];
  const op = r.pick(ops);
  if (op === "addTable") {
    const free = tableNames.filter((n) => !model.tables.some((x) => x.name === n));
    if (free.length > 0) model.tables.push(newTable(r, r.pick(free)));
    return;
  }
  if (!t) return;
  const col = t.columns.length > 0 ? r.pick(t.columns) : undefined;
  const forgetColumn = (table: Table, name: string) => {
    table.columns = table.columns.filter((c) => c.name !== name);
    table.uniques = table.uniques.filter((n) => n !== name);
    table.checks = table.checks.filter((n) => n !== name);
    table.indexes = table.indexes.filter((n) => n !== name);
    table.fks = table.fks.filter((n) => n !== name);
    for (const v of model.views) {
      if (v.table === table.name) v.columns = v.columns.filter((n) => n !== name);
    }
  };
  switch (op) {
    case "dropTable":
      model.tables = model.tables.filter((x) => x.name !== t.name);
      model.views = model.views.filter((v) => v.table !== t.name);
      for (const other of model.tables) forgetColumn(other, `ref_${t.name}`);
      break;
    case "addColumn": {
      const c = newColumn(r, new Set(t.columns.map((x) => x.name)));
      if (c) {
        t.columns.push(c);
        decorate(r, t, c);
      }
      break;
    }
    case "dropColumn":
      if (col) forgetColumn(t, col.name);
      break;
    case "retype":
      if (col && !t.fks.includes(col.name)) {
        const to = r.pick(RETYPES[col.type] ?? []);
        if (to) {
          col.type = to;
          col.default = null;
          // A check written for the old type may not make sense for the new one.
          t.checks = t.checks.filter((n) => n !== col.name);
          t.uniques = t.uniques.filter((n) => n !== col.name || col.type !== "boolean");
        }
      }
      break;
    case "notNull":
      if (col) col.notNull = !col.notNull;
      break;
    case "default":
      if (col && !t.fks.includes(col.name)) {
        col.default = col.default === null ? r.pick(DEFAULTS[col.type]!) : null;
      }
      break;
    case "addIndex":
      if (col && !t.indexes.includes(col.name)) t.indexes.push(col.name);
      break;
    case "dropIndex":
      t.indexes = t.indexes.filter((n) => n !== t.indexes[0]);
      break;
    case "addUnique":
      if (col && col.type !== "boolean" && !t.uniques.includes(col.name)) t.uniques.push(col.name);
      break;
    case "dropUnique":
      t.uniques = t.uniques.slice(1);
      break;
    case "addCheck":
      if (col && (isNumeric(col.type) || col.type === "text" || col.type === "varchar(20)")) {
        if (!t.checks.includes(col.name)) t.checks.push(col.name);
      }
      break;
    case "dropCheck":
      t.checks = t.checks.slice(1);
      break;
    case "addFk":
      addFk(r, model, t);
      break;
    case "dropFk":
      if (t.fks[0]) forgetColumn(t, t.fks[0]);
      break;
    case "addView":
      addView(r, model, t);
      break;
    case "changeView": {
      const v = model.views.find((x) => x.table === t.name);
      if (v) v.columns = t.columns.filter(() => r.chance(0.6)).map((c) => c.name);
      break;
    }
    case "dropView":
      model.views = model.views.filter((v) => v.table !== t.name);
      break;
    case "comment":
      if (col) col.comment = col.comment === null ? "a comment" : null;
      else t.comment = t.comment === null ? "a table" : null;
      break;
  }
}

// ------------------------------------------------------------------------------ SQL

const checkSql = (t: Table, name: string): string => {
  const c = t.columns.find((x) => x.name === name)!;
  return isNumeric(c.type) ? `${name} >= 0` : `length(${name}) < 15`;
};

function toSql(model: Model): string {
  const out: string[] = [];
  for (const t of model.tables) {
    const cols = [
      "id integer PRIMARY KEY",
      ...t.columns.map(
        (c) =>
          `${c.name} ${c.type}${c.notNull ? " NOT NULL" : ""}${c.default !== null ? ` DEFAULT ${c.default}` : ""}`,
      ),
    ];
    out.push(`CREATE TABLE {s}.${t.name} (${cols.join(", ")});`);
    if (t.comment) out.push(`COMMENT ON TABLE {s}.${t.name} IS '${t.comment}';`);
    for (const c of t.columns) {
      if (c.comment) out.push(`COMMENT ON COLUMN {s}.${t.name}.${c.name} IS '${c.comment}';`);
    }
  }
  for (const t of model.tables) {
    for (const n of t.uniques) {
      out.push(`ALTER TABLE {s}.${t.name} ADD CONSTRAINT uq_${t.name}_${n} UNIQUE (${n});`);
    }
    for (const n of t.checks) {
      out.push(
        `ALTER TABLE {s}.${t.name} ADD CONSTRAINT ck_${t.name}_${n} CHECK (${checkSql(t, n)});`,
      );
    }
    for (const n of t.indexes) out.push(`CREATE INDEX ix_${t.name}_${n} ON {s}.${t.name} (${n});`);
    for (const n of t.fks) {
      out.push(
        `ALTER TABLE {s}.${t.name} ADD CONSTRAINT fk_${t.name}_${n} FOREIGN KEY (${n}) REFERENCES {s}.${n.slice(4)} (id);`,
      );
    }
  }
  for (const v of model.views) {
    out.push(
      `CREATE VIEW {s}.${v.name} AS SELECT ${["id", ...v.columns].join(", ")} FROM {s}.${v.table};`,
    );
  }
  return out.join("\n");
}

// ----------------------------------------------------------------------------- the test

const runs = Number(process.env.DATACANVAS_PROPERTY_RUNS ?? 40);
const only = process.env.DATACANVAS_PROPERTY_SEED;

describe.skipIf(!testDatabaseUrl())("the planner on random databases", () => {
  let pair: Pair;
  beforeAll(async () => {
    pair = await createPair();
  }, 120_000);
  afterAll(async () => {
    await disposePair(pair);
  });

  // What the pairs covered, so a generator that stops producing changes cannot pass quietly.
  const seen = new Set<string>();
  let withSteps = 0;
  const seeds = only ? [Number(only)] : Array.from({ length: runs }, (_, i) => 1000 + i);
  it.each(seeds)(
    "seed %i: the plan makes the database equal the target, and its rollback undoes it",
    async (seed) => {
      const r = new Random(mulberry32(seed));
      const from = generate(r);
      const to: Model = structuredClone(from);
      for (let i = r.int(4) + 1; i > 0; i--) mutate(r, to);
      const scenario = {
        name: `seed ${seed}`,
        from: `CREATE SCHEMA {s}; ${toSql(from)}`,
        to: `CREATE SCHEMA {s}; ${toSql(to)}`,
      };
      const result = await runPlanScenario(pair, scenario);
      if (result.plan.steps.length > 0) withSteps += 1;
      for (const step of result.plan.steps) seen.add(step.kind);
      const replay = `seed ${seed}\n--- from\n${scenario.from}\n--- to\n${scenario.to}\n--- up\n${result.plan.steps.map((s) => s.up).join("\n")}`;
      expect(result.upError, replay).toBeNull();
      expect(result.upDifferences, replay).toEqual([]);
      expect(result.downError, replay).toBeNull();
      expect(result.downDifferences, replay).toEqual([]);
    },
    60_000,
  );

  it.skipIf(only !== undefined)("covered a spread of changes", () => {
    expect(withSteps).toBeGreaterThan(runs * 0.6);
    expect(seen.size).toBeGreaterThanOrEqual(12);
  });
});
