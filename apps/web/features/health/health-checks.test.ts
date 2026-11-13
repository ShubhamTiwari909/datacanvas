import type {
  ColumnInfo,
  ConstraintInfo,
  IndexInfo,
  RelationshipInfo,
  TableDetailsEntry,
} from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  WIDE_TABLE_COLUMNS,
  indexColumnName,
  runHealthChecks,
  type HealthCheckId,
} from "./health-checks";

const col = (name: string, nullable = false): ColumnInfo => ({
  name,
  ordinalPosition: 1,
  dataType: "integer",
  nullable,
  defaultValue: null,
  comment: null,
});
const pk = (...columns: string[]): ConstraintInfo => ({
  name: "pk",
  kind: "primary_key",
  columns,
  definition: null,
});
const index = (name: string, columns: string[], extra: Partial<IndexInfo> = {}): IndexInfo => ({
  name,
  columns,
  unique: false,
  primary: false,
  method: "btree",
  definition: `CREATE INDEX ${name} ON public.t USING btree (${columns.join(", ")})`,
  ...extra,
});
function entry(
  name: string,
  parts: Partial<Omit<TableDetailsEntry, "table">> & {
    rows?: number | null;
    kind?: "table" | "view";
    schema?: string;
  } = {},
): TableDetailsEntry {
  return {
    table: {
      schema: parts.schema ?? "public",
      name,
      kind: parts.kind ?? "table",
      comment: null,
      estimatedRowCount: parts.rows === undefined ? 100_000 : parts.rows,
    },
    columns: parts.columns ?? [col("id")],
    constraints: parts.constraints ?? [pk("id")],
    indexes: parts.indexes ?? [index(`${name}_pkey`, ["id"], { unique: true, primary: true })],
  };
}
const rel = (
  source: string,
  columns: string[],
  target = "parent",
  sourceSchema = "public",
): RelationshipInfo => ({
  name: `${source}_fk`,
  source: { schema: sourceSchema, table: source, columns },
  target: { schema: "public", table: target, columns: ["id"] },
  cardinality: "many-to-one",
  onDelete: "no_action",
  onUpdate: "no_action",
});
const of = (check: HealthCheckId, report: ReturnType<typeof runHealthChecks>) =>
  report.findings.filter((f) => f.check === check);

describe("helpers", () => {
  it("strips the quoting PostgreSQL puts on index key names, but not on expressions", () => {
    expect(indexColumnName("id")).toBe("id");
    expect(indexColumnName('"select"')).toBe("select");
    expect(indexColumnName('"we""ird"')).toBe('we"ird');
    expect(indexColumnName("lower(email)")).toBe("lower(email)");
    expect(indexColumnName('"a" || "b"')).toBe('"a" || "b"');
  });
});

describe("no_primary_key", () => {
  it("flags a table without one, but not views", () => {
    const report = runHealthChecks(
      [
        entry("loose", { constraints: [], indexes: [] }),
        entry("v", { kind: "view", constraints: [], indexes: [] }),
        entry("fine"),
      ],
      [],
    );
    expect(of("no_primary_key", report).map((f) => f.table)).toEqual(["loose"]);
    expect(report.checkedTables).toBe(2);
  });
});

describe("foreign_key_without_index", () => {
  const child = (indexes: IndexInfo[], rows: number | null = 100_000) =>
    entry("child", { columns: [col("id"), col("parent_id"), col("b")], indexes, rows });

  it("flags a foreign key with no index and suggests a quoted CREATE INDEX", () => {
    const report = runHealthChecks([child([])], [rel("child", ["parent_id"])]);
    const [finding] = of("foreign_key_without_index", report);
    expect(finding?.severity).toBe("warning");
    expect(finding?.suggestion).toBe('CREATE INDEX ON "public"."child" ("parent_id");');
  });

  it("accepts an index that starts with the column", () => {
    const report = runHealthChecks(
      [child([index("i", ["parent_id", "b"])])],
      [rel("child", ["parent_id"])],
    );
    expect(of("foreign_key_without_index", report)).toEqual([]);
  });

  it("does not accept an index where the column is not first", () => {
    const report = runHealthChecks(
      [child([index("i", ["b", "parent_id"])])],
      [rel("child", ["parent_id"])],
    );
    expect(of("foreign_key_without_index", report)).toHaveLength(1);
  });

  it("accepts a composite foreign key's columns in any order at the front", () => {
    const report = runHealthChecks(
      [child([index("i", ["b", "parent_id"])])],
      [rel("child", ["parent_id", "b"])],
    );
    expect(of("foreign_key_without_index", report)).toEqual([]);
  });

  it("does not accept a partial index, or an index type that cannot serve equality lookups", () => {
    const partial = index("p", ["parent_id"], {
      definition: "CREATE INDEX p ON public.child USING btree (parent_id) WHERE (b > 1)",
    });
    const gin = index("g", ["parent_id"], { method: "gin" });
    for (const idx of [partial, gin]) {
      const report = runHealthChecks([child([idx])], [rel("child", ["parent_id"])]);
      expect(of("foreign_key_without_index", report), idx.name).toHaveLength(1);
    }
  });

  it("accepts the primary key index when the foreign key is the key", () => {
    const report = runHealthChecks(
      [entry("child", { columns: [col("id")] })],
      [rel("child", ["id"])],
    );
    expect(of("foreign_key_without_index", report)).toEqual([]);
  });

  it("matches index names that PostgreSQL printed with quotes", () => {
    const report = runHealthChecks(
      [
        entry("child", {
          columns: [col("id"), col("select")],
          indexes: [index("i", ['"select"'])],
        }),
      ],
      [rel("child", ["select"])],
    );
    expect(of("foreign_key_without_index", report)).toEqual([]);
  });

  it("downgrades to information for a small table, keeps a warning when the size is unknown", () => {
    const small = runHealthChecks([child([], 50)], [rel("child", ["parent_id"])]);
    expect(of("foreign_key_without_index", small)[0]?.severity).toBe("info");
    const unknown = runHealthChecks([child([], null)], [rel("child", ["parent_id"])]);
    expect(of("foreign_key_without_index", unknown)[0]?.severity).toBe("warning");
  });

  it("ignores foreign keys whose table was not examined", () => {
    expect(runHealthChecks([], [rel("elsewhere", ["x"])]).findings).toEqual([]);
  });
});

describe("duplicate_index", () => {
  it("flags indexes with identical definitions and suggests dropping a plain one", () => {
    const report = runHealthChecks(
      [entry("t", { indexes: [index("a", ["x"]), index("b", ["x"])] })],
      [],
    );
    const [f] = of("duplicate_index", report);
    expect(f?.message).toContain("a, b");
    expect(f?.suggestion).toBe('DROP INDEX "public"."a";');
  });

  it("does not suggest dropping when every copy is unique or primary", () => {
    const report = runHealthChecks(
      [
        entry("t", {
          indexes: [
            index("p", ["id"], { unique: true, primary: true }),
            index("u", ["id"], { unique: true }),
          ],
        }),
      ],
      [],
    );
    expect(of("duplicate_index", report)[0]?.suggestion).toBeNull();
  });

  it("treats a different predicate or method as a different index", () => {
    const where = index("w", ["x"], {
      definition: "CREATE INDEX w ON public.t USING btree (x) WHERE (x > 1)",
    });
    const report = runHealthChecks(
      [entry("t", { indexes: [index("a", ["x"]), where, index("h", ["x"], { method: "hash" })] })],
      [],
    );
    expect(of("duplicate_index", report)).toEqual([]);
  });
});

describe("redundant_index", () => {
  it("flags an index that is the prefix of a longer one", () => {
    const report = runHealthChecks(
      [entry("t", { indexes: [index("short", ["a"]), index("long", ["a", "b"])] })],
      [],
    );
    const [f] = of("redundant_index", report);
    expect(f?.message).toContain("short");
    expect(f?.severity).toBe("info");
  });

  it("does not flag unique, partial, INCLUDE or non-prefix indexes", () => {
    const report = runHealthChecks(
      [
        entry("t", {
          indexes: [
            index("uniq", ["a"], { unique: true }),
            index("other", ["b"]),
            index("long", ["a", "b"]),
            index("inc", ["c"], {
              definition: "CREATE INDEX inc ON public.t USING btree (c) INCLUDE (d)",
            }),
            index("c2", ["c", "d"]),
          ],
        }),
      ],
      [],
    );
    expect(of("redundant_index", report).map((f) => f.message.split(" ")[1])).toEqual([]);
  });

  it("does not double-report exact duplicates", () => {
    const report = runHealthChecks(
      [entry("t", { indexes: [index("a", ["x"]), index("b", ["x"])] })],
      [],
    );
    expect(of("redundant_index", report)).toEqual([]);
  });
});

describe("nullable_foreign_key and wide_table", () => {
  it("flags foreign key columns that allow NULL", () => {
    const report = runHealthChecks(
      [entry("child", { columns: [col("id"), col("parent_id", true)] })],
      [rel("child", ["parent_id"])],
    );
    expect(of("nullable_foreign_key", report)).toHaveLength(1);
    const notNull = runHealthChecks(
      [entry("child", { columns: [col("id"), col("parent_id", false)] })],
      [rel("child", ["parent_id"])],
    );
    expect(of("nullable_foreign_key", notNull)).toEqual([]);
  });

  it("flags tables with more than the threshold of columns", () => {
    const wide = entry("wide", {
      columns: Array.from({ length: WIDE_TABLE_COLUMNS + 1 }, (_v, i) => col(`c${i}`)),
    });
    const exact = entry("exact", {
      columns: Array.from({ length: WIDE_TABLE_COLUMNS }, (_v, i) => col(`c${i}`)),
    });
    expect(of("wide_table", runHealthChecks([wide, exact], [])).map((f) => f.table)).toEqual([
      "wide",
    ]);
  });
});

describe("report", () => {
  it("is empty for a healthy table", () => {
    expect(runHealthChecks([entry("ok")], []).findings).toEqual([]);
  });

  it("orders findings by check, then severity, then name", () => {
    const report = runHealthChecks(
      [
        entry("b", { constraints: [], indexes: [] }),
        entry("a", { constraints: [], indexes: [] }),
        entry("c", { columns: [col("id"), col("p")], rows: 10, indexes: [] }),
      ],
      [rel("c", ["p"])],
    );
    expect(report.findings.map((f) => `${f.check}:${f.table}`)).toEqual([
      "no_primary_key:a",
      "no_primary_key:b",
      "foreign_key_without_index:c",
    ]);
  });
});
