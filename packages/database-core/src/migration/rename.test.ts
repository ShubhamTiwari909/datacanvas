import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "../models.js";
import type { DatabaseStructure, StructureTable } from "../structure.js";
import { planMigration } from "./plan.js";
import { applyRenames, printedIdentifier, replaceIdentifier, suggestRenames } from "./rename.js";

const col = (name: string, dataType = "integer"): ColumnInfo => ({
  name,
  ordinalPosition: 1,
  dataType,
  nullable: true,
  defaultValue: null,
  comment: null,
});
const table = (name: string, columns: ColumnInfo[]): StructureTable => ({
  schema: "public",
  name,
  kind: "table",
  comment: null,
  columns: columns.map((c, i) => ({ ...c, ordinalPosition: i + 1 })),
  constraints: [],
  indexes: [],
});
const structure = (tables: StructureTable[]): DatabaseStructure => ({
  schemas: ["public"],
  tables,
  relationships: [],
  objects: null,
  ddl: null,
});

describe("identifiers in text", () => {
  it("prints a name the way PostgreSQL does", () => {
    expect(printedIdentifier("orders")).toBe("orders");
    expect(printedIdentifier("Orders")).toBe('"Orders"');
    expect(printedIdentifier("order")).toBe('"order"');
    expect(printedIdentifier('a"b')).toBe('"a""b"');
  });

  it("replaces an identifier, not a longer name and not text in a string", () => {
    expect(replaceIdentifier("CHECK ((qty > 0))", "qty", "amount")).toBe("CHECK ((amount > 0))");
    expect(replaceIdentifier("CHECK ((qty_max > 0))", "qty", "amount")).toBe(
      "CHECK ((qty_max > 0))",
    );
    expect(replaceIdentifier("(note = 'qty')", "qty", "amount")).toBe("(note = 'qty')");
    expect(replaceIdentifier('("qty" > 0)', "qty", "amount")).toBe("(amount > 0)");
  });
});

describe("suggestRenames", () => {
  const cols = [col("id"), col("name", "text")];

  it("suggests a table that is gone and one that is new with the same columns", () => {
    const [s, ...rest] = suggestRenames(
      structure([table("old", cols)]),
      structure([table("fresh", cols)]),
    );
    expect(rest).toEqual([]);
    expect(s).toMatchObject({
      kind: "table",
      oldName: "old",
      newName: "fresh",
      confidence: "high",
    });
    expect(s!.evidence.join(" ")).toMatch(/same 2 columns/);
  });

  it("does not suggest tables whose columns differ in type or count", () => {
    expect(
      suggestRenames(
        structure([table("old", cols)]),
        structure([table("fresh", [col("id"), col("name", "integer")])]),
      ),
    ).toEqual([]);
    expect(
      suggestRenames(structure([table("old", cols)]), structure([table("fresh", [col("id")])])),
    ).toEqual([]);
  });

  it("says when two tables fit equally well", () => {
    const suggestions = suggestRenames(
      structure([table("a1", cols), table("a2", cols)]),
      structure([table("b1", cols), table("b2", cols)]),
    );
    expect(suggestions).toHaveLength(2);
    expect(suggestions.every((s) => s.confidence === "low" && s.alternatives.length > 0)).toBe(
      true,
    );
  });

  it("suggests a column of the same type in the same place", () => {
    const [s] = suggestRenames(
      structure([table("t", [col("id"), col("qty")])]),
      structure([table("t", [col("id"), col("amount")])]),
    );
    expect(s).toMatchObject({
      kind: "column",
      oldName: "qty",
      newName: "amount",
      confidence: "high",
    });
  });

  it("makes the column of a renamed table depend on the table", () => {
    const suggestions = suggestRenames(
      structure([table("old", [col("id"), col("qty")])]),
      structure([table("fresh", [col("id"), col("amount")])]),
    );
    const column = suggestions.find((s) => s.kind === "column");
    expect(column?.requires).toEqual([suggestions.find((s) => s.kind === "table")!.id]);
  });
});

describe("planMigration with renames", () => {
  const from = structure([table("old", [col("id"), col("name", "text")])]);
  const to = structure([table("fresh", [col("id"), col("name", "text")])]);

  it("is a drop and an add until a rename is confirmed", () => {
    expect(planMigration(from, to).steps.map((s) => s.kind)).toEqual([
      "drop_table",
      "create_table",
    ]);
  });

  it("renames when confirmed, and keeps the rows by not dropping", () => {
    const [s] = suggestRenames(from, to);
    const plan = planMigration(from, to, { renames: [s!.id] });
    expect(plan.steps.map((x) => x.kind)).toEqual(["rename_table"]);
    expect(plan.steps[0]!.up).toBe('ALTER TABLE "public"."old" RENAME TO "fresh";');
    expect(plan.steps[0]!.down).toBe('ALTER TABLE "public"."fresh" RENAME TO "old";');
    expect(plan.reversibility).toBe("full");
  });

  it("leaves out, and says so, a rename that does not apply", () => {
    const plan = planMigration(from, to, { renames: ["table:nonsense"] });
    expect(plan.steps.map((x) => x.kind)).toEqual(["drop_table", "create_table"]);
    expect(plan.warnings.join(" ")).toMatch(/table:nonsense/);
  });

  it("ignores a column rename whose table rename is not confirmed", () => {
    const a = structure([table("old", [col("id"), col("qty")])]);
    const b = structure([table("fresh", [col("id"), col("amount")])]);
    const column = suggestRenames(a, b).find((s) => s.kind === "column")!;
    const applied = applyRenames(a, b, [column.id]);
    expect(applied.drafts).toEqual([]);
    expect(applied.ignored).toEqual([column.id]);
  });
});
