import { describe, expect, it } from "vitest";
import { diffStructures, diffToMarkdown, formatValue } from "./diff.js";
import type {
  ColumnInfo,
  ConstraintInfo,
  IndexInfo,
  RelationshipInfo,
  TableDetailsEntry,
} from "./models.js";
import { buildStructure, type DatabaseStructure } from "./structure.js";

const col = (name: string, o: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  ordinalPosition: 1,
  dataType: "integer",
  nullable: false,
  defaultValue: null,
  comment: null,
  ...o,
});
const pk = (name = "t_pkey", columns = ["id"]): ConstraintInfo => ({
  name,
  kind: "primary_key",
  columns,
  definition: `PRIMARY KEY (${columns.join(", ")})`,
});
const idx = (name: string, columns: string[], o: Partial<IndexInfo> = {}): IndexInfo => ({
  name,
  columns,
  unique: false,
  primary: false,
  method: "btree",
  definition: `CREATE INDEX ${name} ON public.t USING btree (${columns.join(", ")})`,
  ...o,
});
function entry(
  name: string,
  o: {
    schema?: string;
    kind?: "table" | "view";
    comment?: string | null;
    rows?: number | null;
    columns?: ColumnInfo[];
    constraints?: ConstraintInfo[];
    indexes?: IndexInfo[];
  } = {},
): TableDetailsEntry {
  return {
    table: {
      schema: o.schema ?? "public",
      name,
      kind: o.kind ?? "table",
      comment: o.comment ?? null,
      estimatedRowCount: o.rows === undefined ? 100 : o.rows,
    },
    columns: o.columns ?? [col("id")],
    constraints: o.constraints ?? [pk()],
    indexes: o.indexes ?? [idx("t_pkey", ["id"], { unique: true, primary: true })],
  };
}
const fk = (
  source: string,
  target: string,
  o: Partial<RelationshipInfo> = {},
): RelationshipInfo => ({
  name: `${source}_${target}_fk`,
  source: { schema: "public", table: source, columns: [`${target}_id`] },
  target: { schema: "public", table: target, columns: ["id"] },
  cardinality: "many-to-one",
  onDelete: "no_action",
  onUpdate: "no_action",
  ...o,
});
const structure = (
  entries: TableDetailsEntry[],
  relationships: RelationshipInfo[] = [],
  schemas: string[] = ["public"],
): DatabaseStructure => buildStructure(schemas, entries, relationships);
const base = () =>
  structure(
    [entry("users"), entry("orders", { columns: [col("id"), col("users_id")] })],
    [fk("orders", "users")],
  );

describe("buildStructure", () => {
  it("leaves out row estimates, so a busy but unchanged database does not look changed", () => {
    const a = structure([entry("t", { rows: 10 })]);
    const b = structure([entry("t", { rows: 99999 })]);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain("estimatedRowCount");
  });

  it("gives the same value whatever order the input came in", () => {
    const one = structure([entry("b"), entry("a")], [fk("b", "a"), fk("a", "b")]);
    const two = structure([entry("a"), entry("b")], [fk("a", "b"), fk("b", "a")]);
    expect(one).toEqual(two);
  });

  it("adds schemas that only appear on a table, sorted", () => {
    expect(structure([entry("t", { schema: "z" })], [], ["a"]).schemas).toEqual(["a", "z"]);
  });

  it("orders columns by position", () => {
    const s = structure([
      entry("t", { columns: [col("b", { ordinalPosition: 2 }), col("a", { ordinalPosition: 1 })] }),
    ]);
    expect(s.tables[0]?.columns.map((c) => c.name)).toEqual(["a", "b"]);
  });
});

describe("diffStructures: nothing changed", () => {
  it("reports an empty diff for the same structure", () => {
    const diff = diffStructures(base(), base());
    expect(diff.isEmpty).toBe(true);
    expect(diff.tables).toEqual([]);
    const { objects, ...counted } = diff.summary;
    expect(
      [...Object.values(counted), ...Object.values(objects)].every(
        (c) => c.added + c.removed + c.changed === 0,
      ),
    ).toBe(true);
  });
});

describe("diffStructures: tables and schemas", () => {
  it("finds added and removed tables", () => {
    const after = structure([entry("users"), entry("payments")], []);
    const diff = diffStructures(base(), after);
    const byName = Object.fromEntries(diff.tables.map((t) => [t.name, t.status]));
    expect(byName).toEqual({ orders: "removed", payments: "added" });
    expect(diff.summary.tables).toEqual({ added: 1, removed: 1, changed: 0 });
  });

  it("does not list an added or removed table's columns as separate changes", () => {
    const diff = diffStructures(structure([]), structure([entry("t")]));
    expect(diff.tables[0]).toMatchObject({ status: "added", columns: [], indexes: [] });
    expect(diff.summary.columns).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it("finds a changed kind and a changed comment", () => {
    const diff = diffStructures(
      structure([entry("t", { comment: "old" })]),
      structure([entry("t", { kind: "view", comment: "new" })]),
    );
    expect(diff.tables[0]?.table).toEqual([
      { field: "kind", before: "table", after: "view" },
      { field: "comment", before: "old", after: "new" },
    ]);
  });

  it("finds added and removed schemas, including empty ones", () => {
    const diff = diffStructures(
      structure([], [], ["public", "old"]),
      structure([], [], ["public", "new"]),
    );
    expect(diff.schemasAdded).toEqual(["new"]);
    expect(diff.schemasRemoved).toEqual(["old"]);
    expect(diff.isEmpty).toBe(false);
  });

  it("keeps a table with the same name in two schemas apart", () => {
    const before = structure(
      [entry("t", { schema: "a" }), entry("t", { schema: "b" })],
      [],
      ["a", "b"],
    );
    const after = structure([entry("t", { schema: "a" })], [], ["a", "b"]);
    const diff = diffStructures(before, after);
    expect(diff.tables.map((t) => `${t.schema}.${t.name}:${t.status}`)).toEqual(["b.t:removed"]);
  });
});

describe("diffStructures: columns", () => {
  const changed = (before: ColumnInfo[], after: ColumnInfo[]) =>
    diffStructures(
      structure([entry("t", { columns: before })]),
      structure([entry("t", { columns: after })]),
    ).tables[0]?.columns;

  it("finds added and removed columns", () => {
    expect(changed([col("a")], [col("a"), col("b")])?.map((c) => `${c.name}:${c.status}`)).toEqual([
      "b:added",
    ]);
    expect(changed([col("a"), col("b")], [col("a")])?.map((c) => `${c.name}:${c.status}`)).toEqual([
      "b:removed",
    ]);
  });

  it("names exactly which fields of a column changed", () => {
    const [c] =
      changed(
        [col("a", { dataType: "integer", nullable: false, defaultValue: null })],
        [col("a", { dataType: "bigint", nullable: true, defaultValue: "0", comment: "hi" })],
      ) ?? [];
    expect(c?.status === "changed" && c.changes).toEqual([
      { field: "type", before: "integer", after: "bigint" },
      { field: "nullable", before: "false", after: "true" },
      { field: "default", before: "(none)", after: "0" },
      { field: "comment", before: "(none)", after: "hi" },
    ]);
  });

  it("ignores a column that only moved (the diff is empty)", () => {
    const before = structure([
      entry("t", { columns: [col("a", { ordinalPosition: 1 }), col("b", { ordinalPosition: 2 })] }),
    ]);
    const after = structure([
      entry("t", { columns: [col("a", { ordinalPosition: 2 }), col("b", { ordinalPosition: 1 })] }),
    ]);
    expect(diffStructures(before, after).isEmpty).toBe(true);
  });

  it("shows a rename as one removed and one added", () => {
    expect(changed([col("old")], [col("new")])?.map((c) => `${c.name}:${c.status}`)).toEqual([
      "new:added",
      "old:removed",
    ]);
  });
});

describe("diffStructures: constraints, indexes, relationships", () => {
  it("compares non-foreign-key constraints by name", () => {
    const before = structure([
      entry("t", {
        constraints: [
          pk(),
          { name: "u", kind: "unique", columns: ["a"], definition: "UNIQUE (a)" },
        ],
      }),
    ]);
    const after = structure([entry("t", { constraints: [pk("t_pkey", ["id", "x"])] })]);
    const c = diffStructures(before, after).tables[0]?.constraints ?? [];
    expect(c.map((x) => `${x.name}:${x.status}`)).toEqual(["t_pkey:changed", "u:removed"]);
  });

  it("compares indexes by name and shows what changed", () => {
    const before = structure([entry("t", { indexes: [idx("i", ["a"])] })]);
    const after = structure([entry("t", { indexes: [idx("i", ["a", "b"]), idx("j", ["c"])] })]);
    const items = diffStructures(before, after).tables[0]?.indexes ?? [];
    expect(items.map((x) => `${x.name}:${x.status}`)).toEqual(["i:changed", "j:added"]);
    const first = items[0];
    expect(first?.status === "changed" && first.changes.map((c) => c.field)).toEqual([
      "columns",
      "definition",
    ]);
  });

  it("reports a foreign key once, as a relationship, not also as a constraint", () => {
    const fkConstraint: ConstraintInfo = {
      name: "orders_users_fk",
      kind: "foreign_key",
      columns: ["users_id"],
      definition: "FOREIGN KEY ...",
    };
    const before = structure(
      [entry("orders", { constraints: [pk(), fkConstraint] })],
      [fk("orders", "users")],
    );
    const after = structure([entry("orders", { constraints: [pk()] })], []);
    const table = diffStructures(before, after).tables[0];
    expect(table?.constraints).toEqual([]);
    expect(table?.relationships.map((r) => `${r.name}:${r.status}`)).toEqual([
      "orders_users_fk:removed",
    ]);
  });

  it("finds a changed foreign key action", () => {
    const before = structure([entry("orders")], [fk("orders", "users")]);
    const after = structure([entry("orders")], [fk("orders", "users", { onDelete: "cascade" })]);
    const [r] = diffStructures(before, after).tables[0]?.relationships ?? [];
    expect(r?.status === "changed" && r.changes).toEqual([
      { field: "on delete", before: "no_action", after: "cascade" },
    ]);
  });

  it("lists a table as changed when only its foreign keys changed", () => {
    const diff = diffStructures(
      structure([entry("orders")], []),
      structure([entry("orders")], [fk("orders", "users")]),
    );
    expect(diff.tables).toHaveLength(1);
    expect(diff.tables[0]).toMatchObject({ status: "changed", columns: [], indexes: [] });
  });

  it("does not repeat the foreign keys of an added or removed table", () => {
    const diff = diffStructures(
      structure([]),
      structure([entry("orders")], [fk("orders", "users")]),
    );
    expect(diff.summary.relationships).toEqual({ added: 0, removed: 0, changed: 0 });
  });
});

describe("diffStructures: summary and order", () => {
  it("counts everything across tables", () => {
    const before = structure([
      entry("a", { columns: [col("x")] }),
      entry("b", { columns: [col("y")] }),
    ]);
    const after = structure([
      entry("a", { columns: [col("x"), col("z")] }),
      entry("b", { columns: [col("y", { dataType: "text" })] }),
    ]);
    expect(diffStructures(before, after).summary.columns).toEqual({
      added: 1,
      removed: 0,
      changed: 1,
    });
  });

  it("orders tables by schema and name, and gives the same diff every time", () => {
    const after = structure([entry("z"), entry("a"), entry("m")]);
    const diff = diffStructures(structure([]), after);
    expect(diff.tables.map((t) => t.name)).toEqual(["a", "m", "z"]);
    expect(diffStructures(structure([]), after)).toEqual(diff);
  });

  it("is JSON-safe (it travels between server and browser)", () => {
    const diff = diffStructures(
      base(),
      structure([entry("users", { columns: [col("id"), col("n")] })]),
    );
    expect(JSON.parse(JSON.stringify(diff))).toEqual(diff);
  });
});

describe("formatValue", () => {
  it("shows missing values and lists readably", () => {
    expect(formatValue(null)).toBe("(none)");
    expect(formatValue("")).toBe("(none)");
    expect(formatValue([])).toBe("(none)");
    expect(formatValue(["a", "b"])).toBe("a, b");
    expect(formatValue(true)).toBe("true");
  });
});

describe("diffToMarkdown", () => {
  const labels = { before: "Snapshot A", after: "Live" };

  it("says so when nothing differs", () => {
    const text = diffToMarkdown(diffStructures(base(), base()), labels);
    expect(text).toContain("No differences");
    expect(text).toContain("`Snapshot A`");
  });

  it("writes a summary table and one section per table", () => {
    const after = structure([
      entry("users", { columns: [col("id"), col("email")] }),
      entry("payments"),
    ]);
    const text = diffToMarkdown(diffStructures(base(), after), labels);
    expect(text).toContain("| Tables | 1 | 1 | 1 |");
    expect(text).toContain("## Added table `public.payments`");
    expect(text).toContain("## Removed table `public.orders`");
    expect(text).toContain("## Changed table `public.users`");
    expect(text).toContain("- added column `email`");
  });

  it("shows before and after values of a change", () => {
    const text = diffToMarkdown(
      diffStructures(
        structure([entry("t", { columns: [col("a", { dataType: "integer" })] })]),
        structure([entry("t", { columns: [col("a", { dataType: "bigint" })] })]),
      ),
      labels,
    );
    expect(text).toContain("- changed column `a`: type: `integer` → `bigint`");
  });

  it("keeps awkward names and long values from breaking the Markdown", () => {
    const awkward = "we`ird\nname";
    const after = structure([
      entry("t", { columns: [col(awkward, { comment: "x".repeat(500) })] }),
    ]);
    const text = diffToMarkdown(diffStructures(structure([entry("t")]), after), labels);
    expect(text).toContain("`` we`ird name ``");
    expect(text.split("\n").every((line) => line.length < 400)).toBe(true);
  });
});

// ------------------------------------------------------------------ objects ---

import { emptyObjects } from "./objects.js";
import type { DatabaseObjects, FunctionInfo, PolicyInfo, ViewInfo } from "./models.js";
import { OBJECT_KINDS } from "./models.js";

const func = (name: string, args = "", o: Partial<FunctionInfo> = {}): FunctionInfo => ({
  schema: "public",
  name,
  kind: "function",
  arguments: args,
  returns: "integer",
  language: "sql",
  volatility: "volatile",
  securityDefiner: false,
  comment: null,
  definition: `CREATE FUNCTION public.${name}(${args}) ... SELECT 1`,
  ...o,
});
const view = (name: string, o: Partial<ViewInfo> = {}): ViewInfo => ({
  schema: "public",
  name,
  materialized: false,
  comment: null,
  definition: "SELECT 1",
  dependsOn: [],
  ...o,
});
const policy = (name: string, o: Partial<PolicyInfo> = {}): PolicyInfo => ({
  schema: "public",
  table: "t",
  name,
  command: "select",
  permissive: true,
  roles: ["public"],
  using: "(id > 0)",
  withCheck: null,
  ...o,
});
const withObjects = (objects: Partial<DatabaseObjects> | null): DatabaseStructure => ({
  ...structure([entry("t")]),
  objects: objects === null ? null : { ...emptyObjects(), ...objects },
});

const labels = { before: "before", after: "after" };

describe("diffStructures: objects", () => {
  it("finds added, removed and changed objects of each kind", () => {
    const before = withObjects({
      views: [view("v1"), view("v2", { definition: "SELECT 1" })],
      functions: [func("f_old")],
      policies: [policy("p")],
    });
    const after = withObjects({
      views: [view("v2", { definition: "SELECT 2" }), view("v3")],
      functions: [func("f_new")],
      policies: [policy("p", { using: "(id > 5)" })],
    });
    const diff = diffStructures(before, after);

    expect(diff.objects?.views.map((v) => [v.name, v.status])).toEqual([
      ["public.v1", "removed"],
      ["public.v2", "changed"],
      ["public.v3", "added"],
    ]);
    expect(diff.objects?.functions.map((f) => [f.name, f.status])).toEqual([
      ["public.f_new()", "added"],
      ["public.f_old()", "removed"],
    ]);
    expect(diff.summary.objects.views).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(diff.summary.objects.policies).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(diff.isEmpty).toBe(false);
  });

  it("lists exactly which fields of an object changed", () => {
    const diff = diffStructures(
      withObjects({ policies: [policy("p", { roles: ["public"], using: "(id > 0)" })] }),
      withObjects({ policies: [policy("p", { roles: ["alice", "bob"], using: "(id > 5)" })] }),
    );
    const changed = diff.objects!.policies[0]!;
    expect(changed.status === "changed" && changed.changes).toEqual([
      { field: "roles", before: "public", after: "alice, bob" },
      { field: "using", before: "(id > 0)", after: "(id > 5)" },
    ]);
  });

  it("treats overloads as different functions, so changing one does not touch the other", () => {
    const diff = diffStructures(
      withObjects({ functions: [func("f", "a integer"), func("f", "a text")] }),
      withObjects({
        functions: [func("f", "a integer", { volatility: "immutable" }), func("f", "a text")],
      }),
    );
    expect(diff.objects!.functions.map((f) => [f.name, f.status])).toEqual([
      ["public.f(a integer)", "changed"],
    ]);
  });

  it("is empty when the objects are the same", () => {
    const same = withObjects({ views: [view("v")], functions: [func("f")] });
    const diff = diffStructures(same, withObjects({ views: [view("v")], functions: [func("f")] }));
    expect(diff.isEmpty).toBe(true);
    expect(OBJECT_KINDS.every((k) => diff.objects![k].length === 0)).toBe(true);
  });

  it("does not compare objects when either side never recorded them, and says so", () => {
    const recorded = withObjects({ functions: [func("f"), func("g")] });
    const old = withObjects(null);

    for (const diff of [diffStructures(old, recorded), diffStructures(recorded, old)]) {
      expect(diff.objects).toBeNull();
      expect(diff.isEmpty).toBe(true); // nothing else differs, and no function is reported as new
      expect(diffToMarkdown(diff, labels)).toContain("were not compared");
    }
    expect(diffStructures(old, withObjects(null)).objects).toBeNull();
  });

  it("is only about objects when nothing else changed", () => {
    const diff = diffStructures(withObjects({}), withObjects({ functions: [func("f")] }));
    expect(diff.tables).toEqual([]);
    expect(diff.isEmpty).toBe(false);
  });

  it("writes objects into the Markdown report", () => {
    const text = diffToMarkdown(
      diffStructures(
        withObjects({ views: [view("v", { definition: "SELECT 1" })] }),
        withObjects({
          views: [view("v", { definition: "SELECT 2" })],
          functions: [func("f", "a integer")],
        }),
      ),
      labels,
    );
    expect(text).toContain("| Views | 0 | 0 | 1 |");
    expect(text).toContain("| Functions | 1 | 0 | 0 |");
    expect(text).toContain("## Objects");
    expect(text).toContain("- added function `public.f(a integer)`");
    expect(text).toContain("- changed view `public.v`: definition: `SELECT 1` → `SELECT 2`");
  });
});

describe("buildStructure: objects", () => {
  it("keeps null as null (not recorded), and sorts recorded objects", () => {
    expect(buildStructure(["public"], [], []).objects).toBeNull();
    const built = buildStructure(["public"], [], [], {
      ...emptyObjects(),
      functions: [func("b"), func("a")],
    });
    expect(built.objects?.functions.map((f) => f.name)).toEqual(["a", "b"]);
  });
});
