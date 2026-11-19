import { describe, expect, it } from "vitest";
import type { ColumnInfo, ConstraintInfo, IndexInfo } from "../models.js";
import type { DatabaseStructure, StructureTable } from "../structure.js";
import type { DatabaseObjects, TypeInfo, ViewInfo } from "../models.js";
import { emptyObjects } from "../objects.js";
import { downScript, planMigration, upScript } from "./plan.js";

const col = (name: string, dataType = "integer", extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  ordinalPosition: 1,
  dataType,
  nullable: true,
  defaultValue: null,
  comment: null,
  ...extra,
});
const table = (
  name: string,
  columns: ColumnInfo[],
  extra: Partial<StructureTable> = {},
): StructureTable => ({
  schema: "public",
  name,
  kind: "table",
  comment: null,
  columns: columns.map((c, i) => ({ ...c, ordinalPosition: i + 1 })),
  constraints: [],
  indexes: [],
  ...extra,
});
const structure = (tables: StructureTable[]): DatabaseStructure => ({
  schemas: ["public"],
  tables,
  relationships: [],
  objects: null,
  ddl: null,
});
const fk = (name: string, columns: string[], target: string): ConstraintInfo => ({
  name,
  kind: "foreign_key",
  columns,
  definition: `FOREIGN KEY (${columns.join(", ")}) REFERENCES public.${target}(id)`,
});
const index = (name: string, on: string): IndexInfo => ({
  name,
  columns: [on],
  unique: false,
  primary: false,
  method: "btree",
  definition: `CREATE INDEX ${name} ON public.t USING btree (${on})`,
});

describe("planMigration", () => {
  it("plans nothing for equal structures", () => {
    const s = structure([table("t", [col("id")])]);
    const plan = planMigration(s, s);
    expect(plan.steps).toEqual([]);
    expect(plan.reversibility).toBe("full");
  });

  it("is a pure function: the same input gives the same plan", () => {
    const from = structure([table("a", [col("id")])]);
    const to = structure([table("a", [col("id"), col("x", "text")]), table("b", [col("id")])]);
    expect(planMigration(from, to)).toEqual(planMigration(from, to));
  });

  it("creates tables before the foreign keys that point at them", () => {
    const to = structure([
      table("a", [col("id"), col("b_id")], { constraints: [fk("a_b", ["b_id"], "b")] }),
      table("b", [col("id")], { constraints: [fk("b_a", ["id"], "a")] }),
    ]);
    const kinds = planMigration(structure([]), to).steps.map((s) => s.kind);
    expect(kinds.lastIndexOf("create_table")).toBeLessThan(kinds.indexOf("add_constraint"));
  });

  it("drops foreign keys before the tables and adds them last", () => {
    const withFk = structure([
      table("a", [col("id"), col("b_id")], { constraints: [fk("a_b", ["b_id"], "b")] }),
      table("b", [col("id")]),
    ]);
    const drop = planMigration(withFk, structure([]));
    const kinds = drop.steps.map((s) => s.kind);
    expect(kinds.indexOf("drop_constraint")).toBeLessThan(kinds.indexOf("drop_table"));
  });

  it("marks dropping a column destructive and not fully reversible", () => {
    const plan = planMigration(
      structure([table("t", [col("id"), col("x", "text")])]),
      structure([table("t", [col("id")])]),
    );
    const step = plan.steps.find((s) => s.kind === "drop_column")!;
    expect(step.risk).toContain("destructive");
    expect(step.reversibility).toBe("data_lost");
    expect(plan.reversibility).toBe("partial");
  });

  it("never uses CASCADE", () => {
    const plan = planMigration(
      structure([table("a", [col("id")]), table("b", [col("id")])]),
      structure([]),
    );
    expect(upScript(plan)).not.toMatch(/CASCADE/i);
    expect(downScript(plan)).not.toMatch(/CASCADE/i);
  });

  it("quotes every identifier it emits", () => {
    const plan = planMigration(structure([]), structure([table('we"ird', [col("it's")])]));
    expect(upScript(plan)).toContain('"we""ird"');
    expect(upScript(plan)).toContain(`"it's"`);
  });

  it("splits an index into a concurrent, non-transactional step on request", () => {
    const from = structure([table("t", [col("a")])]);
    const to = structure([table("t", [col("a")], { indexes: [index("t_a", "a")] })]);
    const step = planMigration(from, to, { concurrentIndexes: true }).steps.find(
      (s) => s.kind === "create_index",
    )!;
    expect(step.up).toContain("CONCURRENTLY");
    expect(step.transactional).toBe(false);
    const plain = planMigration(from, to).steps.find((s) => s.kind === "create_index")!;
    expect(plain.up).not.toContain("CONCURRENTLY");
  });

  it("says what it did not compare", () => {
    const plan = planMigration(structure([]), structure([]));
    expect(plan.notCompared.length).toBeGreaterThan(0);
  });

  it("reverses the steps for the rollback", () => {
    const plan = planMigration(
      structure([]),
      structure([table("a", [col("id")]), table("b", [col("id")])]),
    );
    const down = downScript(plan);
    expect(down.indexOf('DROP TABLE "public"."b"')).toBeLessThan(
      down.indexOf('DROP TABLE "public"."a"'),
    );
  });
});

const withObjects = (
  s: DatabaseStructure,
  objects: Partial<DatabaseObjects>,
): DatabaseStructure => ({
  ...s,
  objects: { ...emptyObjects(), ...objects },
});
const enumType = (name: string, values: string[]): TypeInfo => ({
  schema: "public",
  name,
  kind: "enum",
  comment: null,
  values,
  attributes: [],
  baseType: null,
  defaultValue: null,
  constraints: [],
});
const view = (name: string, reads: string[], definition = "SELECT 1"): ViewInfo => ({
  schema: "public",
  name,
  materialized: false,
  comment: null,
  definition,
  dependsOn: reads.map((n) => ({ schema: "public", name: n })),
});

describe("planMigration: the objects around the tables", () => {
  it("creates a type before the table that uses it", () => {
    const plan = planMigration(
      withObjects(structure([]), {}),
      withObjects(structure([table("t", [col("m", "mood")])]), {
        types: [enumType("mood", ["a"])],
      }),
    );
    const order = plan.steps.map((s) => s.kind);
    expect(order.indexOf("create_type")).toBeLessThan(order.indexOf("create_table"));
  });

  it("drops views that read views before the views they read, and makes them in the other order", () => {
    const both = withObjects(structure([table("t", [col("id")])]), {
      views: [view("v1", ["t"]), view("v2", ["v1"])],
    });
    const none = withObjects(structure([table("t", [col("id")])]), {});
    const dropped = planMigration(both, none).steps.filter((s) => s.kind === "drop_view");
    expect(dropped.map((s) => s.object.name)).toEqual(["v2", "v1"]);
    const made = planMigration(none, both).steps.filter((s) => s.kind === "create_view");
    expect(made.map((s) => s.object.name)).toEqual(["v1", "v2"]);
    expect(made[1]!.dependsOn).toContain(made[0]!.id);
  });

  it("will not remove or reorder an enum label: a warning, no step", () => {
    const plan = planMigration(
      withObjects(structure([]), { types: [enumType("m", ["a", "b"])] }),
      withObjects(structure([]), { types: [enumType("m", ["b"])] }),
    );
    expect(plan.steps).toEqual([]);
    expect(plan.warnings.join(" ")).toMatch(/cannot do that/);
  });

  it("adds an enum label as a step that cannot be undone or run in a transaction", () => {
    const plan = planMigration(
      withObjects(structure([]), { types: [enumType("m", ["a"])] }),
      withObjects(structure([]), { types: [enumType("m", ["a", "b"])] }),
    );
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      down: null,
      transactional: false,
      reversibility: "none",
    });
    expect(plan.reversibility).toBe("none");
  });

  it("plans no object when one structure never recorded them, and says so", () => {
    const plan = planMigration(
      structure([]),
      withObjects(structure([]), { types: [enumType("m", ["a"])] }),
    );
    expect(plan.steps).toEqual([]);
    expect(plan.notCompared.join(" ")).toMatch(/not recorded/);
  });
});

describe("planMigration: text that is not SQL", () => {
  const lines = (text: string) => text.split(/\r\n|\r|\n/);
  it("keeps a hostile sequence name inside the comment of a sequence that goes with its table", () => {
    const evil = "sq\nDROP SCHEMA public CASCADE; --";
    const seq = {
      schema: "public",
      name: evil,
      dataType: "integer",
      start: "1",
      increment: "1",
      min: "1",
      max: "100",
      cache: "1",
      cycle: false,
      ownedBy: { schema: "public", table: "t", column: "id" },
    };
    const from = withObjects(
      structure([table("t", [{ ...col("id"), defaultValue: "nextval('x'::regclass)" }])]),
      { sequences: [seq] },
    );
    const plan = planMigration(from, withObjects(structure([]), {}));
    const step = plan.steps.find((x) => x.kind === "drop_sequence")!;
    // Only a comment, so it must be one line: a second line would be SQL.
    expect(lines(step.up)).toHaveLength(1);
    expect(step.up.startsWith("-- ")).toBe(true);
  });
  it("keeps a hostile view name inside the comment of a view whose text was cut", () => {
    const evil = "v\rDROP SCHEMA public CASCADE; --";
    const cut = view(evil, [], "SELECT ... [text cut: 25000 characters, fingerprint abc]");
    const plan = planMigration(
      withObjects(structure([]), {
        views: [{ ...cut, definition: "x... [text cut: 25000 characters, fingerprint abcd1234]" }],
      }),
      withObjects(structure([]), {}),
    );
    const step = plan.steps.find((x) => x.kind === "drop_view")!;
    expect(lines(step.down ?? "")).toHaveLength(1);
    expect((step.down ?? "").startsWith("-- ")).toBe(true);
  });
});
