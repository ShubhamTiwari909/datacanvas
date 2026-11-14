import type {
  ColumnInfo,
  ConstraintInfo,
  IndexInfo,
  IndexUsage,
  IndexUsageReport,
  RelationshipInfo,
  TableDetailsEntry,
} from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  LARGE_INDEX_BYTES,
  WIDE_TABLE_COLUMNS,
  compareColumnTypes,
  formatBytes,
  indexColumnName,
  isPlainName,
  stripModifiers,
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

// ------------------------------------------------------------ type_mismatch ---

const typed = (name: string, dataType: string): ColumnInfo => ({ ...col(name), dataType });

describe("compareColumnTypes", () => {
  it.each([
    ["integer", "integer", "same"],
    ["character varying(50)", "character varying(100)", "length_only"],
    ["numeric(10,2)", "numeric(12,4)", "length_only"],
    ["timestamp(3) with time zone", "timestamp with time zone", "length_only"],
    ["text", "character varying(20)", "text_family"],
    ["integer", "bigint", "different"],
    ["smallint", "integer", "different"],
    ["integer", "text", "different"],
    ["integer[]", "integer", "different"],
    ["character(5)", "text", "different"],
  ] as const)("%s vs %s is %s", (a, b, expected) => {
    expect(compareColumnTypes(a, b)).toBe(expected);
  });

  it("does not judge domains, enums or extension types (they only look different)", () => {
    expect(compareColumnTypes("positive_int", "integer")).toBe("unknown");
    expect(compareColumnTypes("mood", "text")).toBe("unknown");
    expect(compareColumnTypes("citext", "text")).toBe("unknown");
    expect(compareColumnTypes("public.my_type", "public.other_type")).toBe("unknown");
  });

  it("strips length and precision, in any position", () => {
    expect(stripModifiers("Character Varying( 255 )")).toBe("character varying");
    expect(stripModifiers("time(6) without time zone")).toBe("time without time zone");
  });
});

describe("type_mismatch", () => {
  const pair = (childType: string, parentType: string, extra: Partial<TableDetailsEntry> = {}) =>
    runHealthChecks(
      [
        entry("parent", { columns: [typed("id", parentType)] }),
        entry("child", {
          columns: [typed("id", "integer"), typed("parent_id", childType)],
          ...extra,
        }),
      ],
      [rel("child", ["parent_id"])],
    );

  it("warns when the integer sizes differ, and suggests the parent's type", () => {
    const [finding] = of("type_mismatch", pair("integer", "bigint"));
    expect(finding).toMatchObject({ table: "child", severity: "warning" });
    expect(finding!.message).toContain("child.parent_id (integer) references parent.id (bigint)");
    expect(finding!.suggestion).toBe(
      'ALTER TABLE "public"."child" ALTER COLUMN "parent_id" TYPE bigint;',
    );
  });

  it("is information for a length-only or text/varchar difference, with no suggestion", () => {
    for (const [child, parent] of [
      ["character varying(50)", "character varying(100)"],
      ["text", "character varying(100)"],
    ] as const) {
      const [finding] = of("type_mismatch", pair(child, parent));
      expect(finding).toMatchObject({ severity: "info", suggestion: null });
    }
  });

  it("is silent when the types match, or one of them is not a built-in type", () => {
    expect(of("type_mismatch", pair("integer", "integer"))).toEqual([]);
    expect(of("type_mismatch", pair("positive_int", "integer"))).toEqual([]);
  });

  it("checks every column of a composite key, pairing them by position", () => {
    const report = runHealthChecks(
      [
        entry("parent", { columns: [typed("a", "integer"), typed("b", "text")] }),
        entry("child", { columns: [typed("x", "integer"), typed("y", "bigint")] }),
      ],
      [
        {
          ...rel("child", ["x", "y"]),
          target: { schema: "public", table: "parent", columns: ["a", "b"] },
        },
      ],
    );
    expect(of("type_mismatch", report)).toHaveLength(1);
    expect(of("type_mismatch", report)[0]!.message).toContain("child.y (bigint)");
  });

  it("quotes awkward names in the suggested statement", () => {
    const report = runHealthChecks(
      [
        entry("parent", { columns: [typed("id", "bigint")] }),
        entry('we"ird', { columns: [typed("id", "integer"), typed('p"id', "integer")] }),
      ],
      [{ ...rel('we"ird', ['p"id']) }],
    );
    expect(of("type_mismatch", report)[0]!.suggestion).toBe(
      'ALTER TABLE "public"."we""ird" ALTER COLUMN "p""id" TYPE bigint;',
    );
  });

  it("skips a relationship whose other table was not examined", () => {
    const report = runHealthChecks(
      [entry("child", { columns: [typed("id", "integer"), typed("parent_id", "integer")] })],
      [rel("child", ["parent_id"], "missing")],
    );
    expect(of("type_mismatch", report)).toEqual([]);
  });
});

// ------------------------------------------------------------- unused_index ---

describe("unused_index", () => {
  const NOW = new Date("2026-11-14T00:00:00.000Z");
  const OLD_RESET = "2026-09-01T00:00:00.000Z";
  const usage = (
    indexes: Array<Partial<IndexUsage> & { index: string }>,
    extra: Partial<IndexUsageReport> = {},
  ): IndexUsageReport => ({
    statsReset: OLD_RESET,
    inRecovery: false,
    indexes: indexes.map((i) => ({
      schema: "public",
      table: "t",
      scans: 0,
      sizeBytes: 1024 * 1024,
      backsConstraint: false,
      valid: true,
      ...i,
    })),
    ...extra,
  });
  const run = (
    report: IndexUsageReport | null,
    indexes: IndexInfo[],
    rels: RelationshipInfo[] = [],
  ) =>
    runHealthChecks(
      [
        entry("t", {
          indexes: [index("t_pkey", ["id"], { unique: true, primary: true }), ...indexes],
        }),
      ],
      rels,
      { usage: report, now: NOW },
    );

  it("does not run without usage counters, and reports nothing about them", () => {
    const report = run(null, [index("t_x", ["x"])]);
    expect(of("unused_index", report)).toEqual([]);
    expect(report.usage).toBeNull();
  });

  it("flags an index with no scans, with its size, the date, and a concurrent drop", () => {
    const report = run(usage([{ index: "t_x" }]), [index("t_x", ["x"])]);
    const [finding] = of("unused_index", report);
    expect(finding!.message).toContain(
      "Index t_x on t (1.0 MB) has not been used since 2026-09-01",
    );
    expect(finding!.suggestion).toBe('DROP INDEX CONCURRENTLY "public"."t_x";');
    expect(report.usage).toEqual({ statsReset: OLD_RESET, inRecovery: false, indexes: 1 });
  });

  it("is a warning only for a large index and old counters; otherwise information", () => {
    const sizes = (bytes: number, reset: string) =>
      of(
        "unused_index",
        run(usage([{ index: "t_x", sizeBytes: bytes }], { statsReset: reset }), [
          index("t_x", ["x"]),
        ]),
      )[0]!;
    expect(sizes(LARGE_INDEX_BYTES, OLD_RESET).severity).toBe("warning");
    expect(sizes(LARGE_INDEX_BYTES - 1, OLD_RESET).severity).toBe("info");
    const young = sizes(LARGE_INDEX_BYTES * 10, "2026-11-12T00:00:00.000Z");
    expect(young.severity).toBe("info");
    expect(young.message).toContain("less than a week old");
  });

  it("treats counters of unknown age as old enough, and does not claim a date", () => {
    const [finding] = of(
      "unused_index",
      run(usage([{ index: "t_x", sizeBytes: LARGE_INDEX_BYTES }], { statsReset: null }), [
        index("t_x", ["x"]),
      ]),
    );
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain("since the server started counting (it does not say when)");
  });

  it("never flags a used index, a constraint's index, a unique or primary index, or a broken one", () => {
    const report = run(
      usage([
        { index: "used", scans: 3 },
        { index: "constraint", backsConstraint: true },
        { index: "uniq" },
        { index: "t_pkey" },
        { index: "broken", valid: false },
      ]),
      [
        index("used", ["a"]),
        index("constraint", ["b"]),
        index("uniq", ["c"], { unique: true }),
        index("broken", ["d"]),
      ],
    );
    expect(of("unused_index", report)).toEqual([]);
  });

  it("ignores counters for tables or indexes that were not examined", () => {
    const report = run(usage([{ index: "ghost" }, { index: "t_x", table: "elsewhere" }]), [
      index("t_x", ["x"]),
    ]);
    expect(of("unused_index", report)).toEqual([]);
  });

  it("explains, and suggests no drop, when it is the only index serving a foreign key", () => {
    const report = run(
      usage([{ index: "t_parent" }]),
      [index("t_parent", ["parent_id"])],
      [rel("t", ["parent_id"])],
    );
    const [finding] = of("unused_index", report);
    expect(finding!.message).toContain("only index that serves the foreign key to parent");
    expect(finding!.suggestion).toBeNull();
  });

  it("still suggests the drop when another index serves the foreign key", () => {
    const report = run(
      usage([{ index: "t_parent_dup" }]),
      [index("t_parent", ["parent_id"]), index("t_parent_dup", ["parent_id", "x"])],
      [rel("t", ["parent_id"])],
    );
    expect(of("unused_index", report)[0]!.suggestion).toContain("t_parent_dup");
  });

  it("formats sizes for people", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1023)).toBe("1023 bytes");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MB");
    expect(formatBytes(250 * 1024 ** 3)).toBe("250 GB");
  });
});

// ------------------------------------------------------------------- naming ---

describe("isPlainName", () => {
  it.each(["users", "order_items", "_tmp", "a1", "x"])("accepts %s", (name) => {
    expect(isPlainName(name)).toBe(true);
  });
  it.each(["Users", "createdAt", "unit price", "1st", "a-b", "naïve", ""])("rejects %s", (name) => {
    expect(isPlainName(name)).toBe(false);
  });
});

describe("inconsistent_naming", () => {
  /** Eleven tidy names (a table and ten columns) around the table that is being judged. */
  const tidy = entry("tidy", {
    columns: Array.from({ length: 10 }, (_, i) => col(`column_${i}`)),
  });

  it("flags names that need quoting when almost everything else is plain", () => {
    const report = runHealthChecks(
      [tidy, entry("orders", { columns: [col("id"), col("createdAt"), col("Unit Price")] })],
      [],
    );
    const [finding] = of("inconsistent_naming", report);
    expect(finding).toMatchObject({ table: "orders", severity: "info", suggestion: null });
    expect(finding!.message).toContain('column "createdAt", column "Unit Price"');
    expect(finding!.message).toMatch(/unlike \d+% of the names/);
  });

  it("flags a table whose own name needs quoting", () => {
    const report = runHealthChecks([tidy, entry("Orders")], []);
    expect(of("inconsistent_naming", report)[0]!.message).toContain('table "Orders"');
  });

  it("says nothing when the whole database uses another style (nothing to compare against)", () => {
    const camel = ["Users", "Orders", "Items"].map((name) =>
      entry(name, { columns: [col("Id"), col("CreatedAt"), col("UnitPrice")] }),
    );
    expect(of("inconsistent_naming", runHealthChecks(camel, []))).toEqual([]);
  });

  it("says nothing when there are too few names to call anything a style", () => {
    expect(of("inconsistent_naming", runHealthChecks([entry("Orders")], []))).toEqual([]);
  });

  it("shortens a long list of offenders", () => {
    const many = entry("wide", {
      columns: Array.from({ length: 8 }, (_, i) => col(`Bad${i}`)),
    });
    const report = runHealthChecks([tidy, tidy2(), many], []);
    expect(of("inconsistent_naming", report)[0]!.message).toContain("and 3 more");
  });

  function tidy2() {
    return entry("tidy_two", { columns: Array.from({ length: 30 }, (_, i) => col(`c_${i}`)) });
  }
});

describe("fk_column_naming", () => {
  /** Six foreign keys: `plain` of them end in _id, the rest are named differently. */
  function database(namesEnding: string[]) {
    const parent = entry("parent");
    const children = namesEnding.map((column, i) =>
      entry(`child_${i}`, { columns: [col("id"), col(column)] }),
    );
    return runHealthChecks(
      [parent, ...children],
      namesEnding.map((column, i) => rel(`child_${i}`, [column])),
    );
  }

  it("flags the odd one out when the rest follow _id", () => {
    const report = database(["a_id", "b_id", "c_id", "d_id", "e_id", "owner"]);
    const [finding] = of("fk_column_naming", report);
    expect(finding).toMatchObject({ table: "child_5", severity: "info" });
    expect(finding!.message).toContain('child_5.owner references parent but does not end in "_id"');
    expect(finding!.message).toContain("83%");
  });

  it("ignores case, and flags a name that ends in id without the underscore", () => {
    const report = database(["A_ID", "b_Id", "c_id", "d_id", "e_id", "userid"]);
    expect(of("fk_column_naming", report).map((f) => f.table)).toEqual(["child_5"]);
  });

  it("says nothing when the style is not dominant, or there are too few keys", () => {
    expect(of("fk_column_naming", database(["a_id", "b_id", "c", "d", "e"]))).toEqual([]);
    expect(of("fk_column_naming", database(["a_id", "b_id", "c_id", "d"]))).toEqual([]);
  });

  it("does not count composite keys", () => {
    const parent = entry("parent");
    const child = entry("child", { columns: [col("id"), col("x"), col("y")] });
    const report = runHealthChecks([parent, child], [rel("child", ["x", "y"])]);
    expect(of("fk_column_naming", report)).toEqual([]);
  });
});
