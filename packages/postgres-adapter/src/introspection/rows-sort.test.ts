/**
 * The statement for a sorted page, as text: the exact shapes, and a generated test
 * that, whatever the request holds, the statement is built from fixed fragments and
 * quoted catalog names only. A value (a paging position, a sort value) is only ever a
 * bound parameter.
 */
import {
  ROWS_CELL_CHARS,
  ROWS_MAX_SORT_VALUE_CHARS,
  ROW_FILTER_OPS,
} from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { buildRowsQuery, type RowsQueryPlan } from "./rows.js";

const plan = (overrides: Partial<RowsQueryPlan> = {}): RowsQueryPlan => ({
  schema: "public",
  table: "users",
  shown: [
    { position: 0, name: "id" },
    { position: 1, name: "email" },
  ],
  keyColumns: ["id"],
  after: null,
  offset: 0,
  limit: 51,
  ...overrides,
});

const CUT = ROWS_CELL_CHARS + 1;
const SORT_CUT = ROWS_MAX_SORT_VALUE_CHARS + 1;

describe("buildRowsQuery with a sort", () => {
  it("orders by the column, the way the database orders by default, then by the key", () => {
    const asc = buildRowsQuery(plan({ sort: { column: "email", direction: "asc" } }));
    expect(asc).toEqual({
      text:
        'SELECT 1 AS r, left(CAST("id" AS text), $1) AS c0, left(CAST("email" AS text), $1) AS c1, CAST("id" AS text) AS k0, ' +
        'left(CAST("email" AS text), $2) AS s0 FROM "public"."users" ORDER BY "public"."users"."email" ASC NULLS LAST, "public"."users"."id" LIMIT $3',
      values: [CUT, SORT_CUT, 51],
    });
    const desc = buildRowsQuery(plan({ sort: { column: "email", direction: "desc" } }));
    expect(desc.text).toContain(
      'ORDER BY "public"."users"."email" DESC NULLS FIRST, "public"."users"."id" LIMIT $3',
    );
  });

  it("reads the sort value for the cursor, cut one character past what a cursor can carry", () => {
    const { text, values } = buildRowsQuery(plan({ sort: { column: "email", direction: "asc" } }));
    expect(text).toContain('left(CAST("email" AS text), $2) AS s0');
    expect(values[1]).toBe(ROWS_MAX_SORT_VALUE_CHARS + 1);
  });

  describe("continuing after a row", () => {
    const after = (direction: "asc" | "desc", value: string | null) =>
      buildRowsQuery(
        plan({
          keyColumns: ["a", "b"],
          sort: { column: "email", direction },
          after: ["7", "x"],
          afterSort: { value },
          limit: 3,
        }),
      );

    it("ascending, after a value: later values, the same value with a later key, then NULLs", () => {
      const { text, values } = after("asc", "bob");
      expect(text).toContain(
        'WHERE ("email" > $5 OR ("email" = $5 AND ROW("a", "b") > ROW($3, $4)) OR "email" IS NULL) ' +
          'ORDER BY "public"."users"."email" ASC NULLS LAST, "public"."users"."a", "public"."users"."b" LIMIT $6',
      );
      expect(values).toEqual([CUT, SORT_CUT, "7", "x", "bob", 3]);
    });

    it("ascending, after NULL: only NULLs are left, with a later key", () => {
      const { text } = after("asc", null);
      expect(text).toContain('WHERE ("email" IS NULL AND ROW("a", "b") > ROW($3, $4)) ORDER BY');
      expect(text).not.toMatch(/"email" [<>=] /);
    });

    it("descending, after a value: smaller values, or the same value with a later key", () => {
      const { text } = after("desc", "bob");
      expect(text).toContain(
        'WHERE ("email" < $5 OR ("email" = $5 AND ROW("a", "b") > ROW($3, $4))) ' +
          'ORDER BY "public"."users"."email" DESC NULLS FIRST, "public"."users"."a", "public"."users"."b"',
      );
    });

    it("descending, after NULL: the NULLs with a later key, then every value", () => {
      const { text } = after("desc", null);
      expect(text).toContain(
        'WHERE (("email" IS NULL AND ROW("a", "b") > ROW($3, $4)) OR "email" IS NOT NULL) ORDER BY',
      );
    });

    it("keeps NULL apart from an empty string: NULL has no parameter, the empty string does", () => {
      expect(after("asc", null).values).not.toContain("");
      expect(after("asc", "").values).toContain("");
      expect(after("asc", "").text).toContain('"email" > $5');
    });
  });

  it("never sorts a table without a key (there would be no tie-breaker)", () => {
    const { text } = buildRowsQuery(
      plan({ keyColumns: [], sort: { column: "email", direction: "asc" } }),
    );
    expect(text).not.toMatch(/ORDER BY|WHERE| AS s0/);
  });

  it("builds the same statement as before when there is no sort", () => {
    expect(buildRowsQuery(plan({ sort: null })).text).toBe(buildRowsQuery(plan()).text);
    expect(buildRowsQuery(plan()).text).not.toContain(" AS s0");
  });

  it("sorting by the key itself is valid, if redundant", () => {
    const { text } = buildRowsQuery(plan({ sort: { column: "id", direction: "desc" } }));
    expect(text).toContain(
      'ORDER BY "public"."users"."id" DESC NULLS FIRST, "public"."users"."id"',
    );
  });
});

// ---------------------------------------------------------------- generated ---

/** A small seeded generator, so a failure can be reproduced from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const NAMES = [
  "id",
  "select",
  'a"b',
  '"',
  '""; DROP TABLE users; --',
  "日本語 🙂",
  "$1",
  "$2 OR 1=1",
  "ID",
  "a\nb",
  "'",
  "x".repeat(63),
  "ORDER BY id",
  "AS text",
];
const VALUES = [
  "1'; DROP TABLE users; --",
  "plain",
  "",
  "$1",
  '"quoted"',
  "ORDER BY 1",
  "日本語 🙂",
  "UNION SELECT password FROM users",
  "x".repeat(400),
];

const ID = '"(?:[^"]|"")*"';
const P = "\\$\\d+";
const idList = `${ID}(?:, ${ID})*`;
const paramList = `${P}(?:, ${P})*`;
const afterKey = `ROW\\(${idList}\\) > ROW\\(${paramList}\\)`;
const AFTER_CONDITION = [
  afterKey,
  `\\(${ID} IS NULL AND ${afterKey}\\)`,
  `\\(\\(${ID} IS NULL AND ${afterKey}\\) OR ${ID} IS NOT NULL\\)`,
  `\\(${ID} > ${P} OR \\(${ID} = ${P} AND ${afterKey}\\) OR ${ID} IS NULL\\)`,
  `\\(${ID} < ${P} OR \\(${ID} = ${P} AND ${afterKey}\\)\\)`,
].join("|");
const FILTER_CONDITION = [
  `${ID} = ${P}`,
  `${ID} IS DISTINCT FROM ${P}`,
  `${ID} (?:>|>=|<|<=) ${P}`,
  `strpos\\(lower\\(CAST\\(${ID} AS text\\)\\), lower\\(${P}\\)\\) > 0`,
  `starts_with\\(lower\\(CAST\\(${ID} AS text\\)\\), lower\\(${P}\\)\\)`,
  `${ID} IS NULL`,
  `${ID} IS NOT NULL`,
].join("|");
const WHERE = `WHERE (?:${FILTER_CONDITION}|${AFTER_CONDITION})(?: AND (?:${FILTER_CONDITION}|${AFTER_CONDITION}))*`;
// In ORDER BY a column is qualified by its table, so that it can never be read as an output alias (`c0`, `r`).
const QUALIFIED = `${ID}\\.${ID}\\.${ID}`;
const ORDER = `ORDER BY (?:${QUALIFIED} (?:ASC NULLS LAST|DESC NULLS FIRST), )?${QUALIFIED}(?:, ${QUALIFIED})*`;
const GRAMMAR = new RegExp(
  `^SELECT 1 AS r` +
    `(?:, left\\(CAST\\(${ID} AS text\\), ${P}\\) AS c\\d+)*` +
    `(?:, CAST\\(${ID} AS text\\) AS k\\d+)*` +
    `(?:, left\\(CAST\\(${ID} AS text\\), ${P}\\) AS s0)?` +
    ` FROM ${ID}\\.${ID}` +
    `(?: ${WHERE})?` +
    `(?: ${ORDER})?` +
    ` LIMIT ${P}(?: OFFSET ${P})?$`,
);

/** The conditions this grammar was written for; the later operators have their own tests (`rows-filter.test.ts`). */
const LEGACY_OPS = ROW_FILTER_OPS.filter((op) =>
  [
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "starts_with",
    "is_null",
    "is_not_null",
  ].includes(op),
);

describe("buildRowsQuery, generated", () => {
  it("is always one of the fixed shapes, made of fixed fragments and quoted catalog names", () => {
    const next = random(20261116);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
    for (let i = 0; i < 400; i += 1) {
      const keyed = next() < 0.8;
      const keyColumns = keyed
        ? Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(NAMES))
        : [];
      const shown = Array.from({ length: Math.floor(next() * 4) }, (_, position) => ({
        position,
        name: pick(NAMES),
      }));
      const sorted = next() < 0.7;
      const direction = next() < 0.5 ? ("asc" as const) : ("desc" as const);
      const continuing = next() < 0.6;
      const sortValue = next() < 0.25 ? null : pick(VALUES);
      const conditions = Array.from({ length: Math.floor(next() * 4) }, () => {
        const op = pick(LEGACY_OPS);
        return op === "is_null" || op === "is_not_null"
          ? { column: pick(NAMES), op }
          : { column: pick(NAMES), op, value: pick(VALUES) };
      });
      const request = plan({
        filters: conditions,
        schema: pick(NAMES),
        table: pick(NAMES),
        shown,
        keyColumns,
        sort: sorted ? { column: pick(NAMES), direction } : null,
        after: continuing && keyed ? keyColumns.map(() => pick(VALUES)) : null,
        afterSort: continuing && keyed && sorted ? { value: sortValue } : null,
        offset: Math.floor(next() * 10_000),
        limit: 1 + Math.floor(next() * 201),
      });
      const { text, values } = buildRowsQuery(request);

      // 1. The text is exactly one of the written shapes once quoted names are replaced.
      expect(text, `case ${i}`).toMatch(GRAMMAR);

      // 2. No value of the request appears outside a quoted name: it is only ever a parameter.
      const outsideNames = text.replace(new RegExp(ID, "g"), "ID");
      for (const value of VALUES) {
        if (value.length >= 3) expect(outsideNames, `case ${i}`).not.toContain(value);
      }

      // 3. Every parameter is used, and only parameters that exist are used (PostgreSQL refuses an unused one).
      const used = new Set([...outsideNames.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      expect(
        [...used].sort((a, b) => a - b),
        `case ${i}`,
      ).toEqual(Array.from({ length: values.length }, (_, n) => n + 1));
    }
  });
});
