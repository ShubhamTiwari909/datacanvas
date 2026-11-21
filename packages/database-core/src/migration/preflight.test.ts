import { describe, expect, it } from "vitest";
import type { ColumnInfo, ConstraintInfo, RelationshipInfo } from "../models.js";
import type { DatabaseStructure, StructureTable } from "../structure.js";
import { planMigration } from "./plan.js";
import { describePreflight, planPreflight, preflightVerdict } from "./preflight.js";

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
  constraints: ConstraintInfo[] = [],
): StructureTable => ({
  schema: "public",
  name,
  kind: "table",
  comment: null,
  columns: columns.map((c, i) => ({ ...c, ordinalPosition: i + 1 })),
  constraints,
  indexes: [],
});
const structure = (
  tables: StructureTable[],
  relationships: RelationshipInfo[] = [],
): DatabaseStructure => ({ schemas: ["public"], tables, relationships, objects: null, ddl: null });

const link = (name: string): RelationshipInfo => ({
  name,
  source: { schema: "public", table: "child", columns: ["parent_id"] },
  target: { schema: "public", table: "parent", columns: ["id"] },
  cardinality: "many-to-one",
  onDelete: "no_action",
  onUpdate: "no_action",
});

const preflight = (from: DatabaseStructure, to: DatabaseStructure) =>
  planPreflight(planMigration(from, to).steps, to);

describe("planPreflight", () => {
  const base = [table("parent", [col("id")]), table("child", [col("id"), col("parent_id")])];

  it("asks for the NULLs before SET NOT NULL", () => {
    const to = structure([
      table("parent", [col("id")]),
      table("child", [col("id"), col("parent_id", "integer", { nullable: false })]),
    ]);
    expect(preflight(structure(base), to)).toEqual([
      {
        stepId: expect.any(String),
        checks: [{ kind: "nulls", schema: "public", table: "child", column: "parent_id" }],
        unchecked: null,
      },
    ]);
  });

  it("asks whether the table has rows before a column that cannot be NULL and has no default", () => {
    const to = structure([
      table("parent", [col("id")]),
      table("child", [col("id"), col("parent_id"), col("added", "text", { nullable: false })]),
    ]);
    const [only] = preflight(structure(base), to);
    expect(only!.checks).toEqual([{ kind: "rows", schema: "public", table: "child" }]);
  });

  it("asks for duplicates before a unique key, and for NULLs too before a primary key", () => {
    const unique: ConstraintInfo = {
      name: "child_uq",
      kind: "unique",
      columns: ["id", "parent_id"],
      definition: "UNIQUE (id, parent_id)",
    };
    const pk: ConstraintInfo = {
      name: "child_pkey",
      kind: "primary_key",
      columns: ["id"],
      definition: "PRIMARY KEY (id)",
    };
    const withUnique = structure([
      base[0]!,
      table("child", [col("id"), col("parent_id")], [unique]),
    ]);
    expect(preflight(structure(base), withUnique)[0]!.checks).toEqual([
      { kind: "duplicates", schema: "public", table: "child", columns: ["id", "parent_id"] },
    ]);
    const withPk = structure([base[0]!, table("child", [col("id"), col("parent_id")], [pk])]);
    expect(preflight(structure(base), withPk)[0]!.checks).toEqual([
      { kind: "nulls", schema: "public", table: "child", column: "id" },
      { kind: "duplicates", schema: "public", table: "child", columns: ["id"] },
    ]);
  });

  it("asks for orphans before a foreign key, naming the table it points at", () => {
    const fk: ConstraintInfo = {
      name: "child_parent_fk",
      kind: "foreign_key",
      columns: ["parent_id"],
      definition: "FOREIGN KEY (parent_id) REFERENCES public.parent(id)",
    };
    const to = structure(
      [base[0]!, table("child", [col("id"), col("parent_id")], [fk])],
      [link("child_parent_fk")],
    );
    expect(preflight(structure(base), to)[0]!.checks).toEqual([
      {
        kind: "orphans",
        schema: "public",
        table: "child",
        columns: ["parent_id"],
        refSchema: "public",
        refTable: "parent",
        refColumns: ["id"],
      },
    ]);
  });

  it("says why a check constraint and a narrowing type change are not tried, and never builds one from their text", () => {
    const check: ConstraintInfo = {
      name: "child_ck",
      kind: "check",
      columns: ["id"],
      definition: "CHECK ((id > 0))",
    };
    const withCheck = structure([base[0]!, table("child", [col("id"), col("parent_id")], [check])]);
    const [c] = preflight(structure(base), withCheck);
    expect(c).toMatchObject({ checks: [], unchecked: "check" });

    const wide = structure([table("t", [col("n", "bigint")])]);
    const narrow = structure([table("t", [col("n", "smallint")])]);
    const [t] = preflight(wide, narrow);
    expect(t).toMatchObject({ checks: [], unchecked: "type" });
    expect(JSON.stringify([c, t])).not.toMatch(/id > 0/);
  });

  it("leaves a step that cannot fail alone", () => {
    const to = structure([
      table("parent", [col("id")]),
      table("child", [col("id"), col("parent_id"), col("nullable_new", "text")]),
    ]);
    expect(preflight(structure(base), to)).toEqual([]);
  });
});

describe("describePreflight and preflightVerdict", () => {
  const nulls = { kind: "nulls", schema: "public", table: "t", column: "c" } as const;

  it("says what was found with numbers and names, in fixed words", () => {
    expect(describePreflight(nulls, { status: "fails", count: 1 })).toBe(
      "1 row has NULL in c, so this step would fail.",
    );
    expect(describePreflight(nulls, { status: "fails", count: 1200 })).toBe(
      "1,200 rows have NULL in c, so this step would fail.",
    );
    expect(describePreflight(nulls, { status: "ok", count: 0 })).toBe("No row has NULL in c.");
    expect(describePreflight(nulls, { status: "missing", count: 0 })).toMatch(/nothing to check/);
    expect(describePreflight(nulls, { status: "too_slow", count: 0 })).toMatch(/too long/);
  });

  it("takes the worst of several checks as the verdict of a step", () => {
    const ok = { status: "ok", count: 0 } as const;
    const fails = { status: "fails", count: 3 } as const;
    const missing = { status: "missing", count: 0 } as const;
    expect(preflightVerdict([])).toBe("unchecked");
    expect(preflightVerdict([ok, ok])).toBe("ok");
    expect(preflightVerdict([ok, fails])).toBe("fails");
    expect(preflightVerdict([ok, missing])).toBe("partly");
  });
});
