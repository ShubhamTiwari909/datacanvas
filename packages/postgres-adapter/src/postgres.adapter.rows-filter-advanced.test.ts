/**
 * The conditions added for the advanced data workspace (`docs/advanced-data-workspace-plan.md`,
 * section 4), against a real PostgreSQL: text (ends with, does not contain, a pattern, empty),
 * lists and ranges, the date shortcuts on a date, a timestamp and a timestamptz, JSON (a key,
 * what it contains, a path), arrays, groups of conditions joined by OR, hostile values, hidden
 * columns, and paging through a grouped filter.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set. Runs in its own throwaway database.
 */
import type { RowFilter, RowsOptions } from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const SQL = `
  CREATE TABLE adv (
    id integer PRIMARY KEY, name text, score integer, born date, at timestamptz, ts timestamp,
    doc jsonb, jdoc json, tags text[], nums integer[], secret_token text
  );
  INSERT INTO adv VALUES
   (1, 'alpha', 1, current_date, now(), localtimestamp,
      '{"k": 1, "a": {"b": [10, 20]}, "name": "x"}', '{"k": 1}', '{x,y}', '{1,2,3}', 'one'),
   (2, 'beta', 2, current_date - 3, now() - interval '3 days', localtimestamp - interval '3 days',
      '{"k": 2, "tags": ["t"]}', '{"k": 2, "w": [1]}', '{y,z}', '{3,4}', 'two'),
   (3, 'gamma', 3, current_date - 10, now() - interval '10 days', localtimestamp - interval '10 days',
      '{"z": null}', '[1, 2]', '{}', '{}', 'three'),
   (4, 'delta', NULL, current_date - 40, now() - interval '40 days', localtimestamp - interval '40 days',
      NULL, NULL, NULL, NULL, 'four'),
   (5, '', 5, NULL, NULL, NULL, '[]', '{}', '{x}', '{5}', 'five'),
   (6, NULL, 6, current_date - 29, now() - interval '29 days', localtimestamp - interval '29 days',
      '{"k": "1"}', '{"k": "1"}', '{"a,b","c\\"d"}', '{6,7}', 'six'),
   (7, '50% off_x', 7, current_date + 1, now() + interval '1 day', localtimestamp + interval '1 day',
      '{"a": {"b": {"c": true}}}', '{"a": 1}', '{"{x}"}', '{1}', 'seven'),
   (8, 'ALPHA beta', 8, current_date - 6, now() - interval '6 days', localtimestamp - interval '6 days',
      '{"k": 1, "tags": ["t", "u"]}', '{"k": 3}', '{y}', '{2}', 'eight'),
   (9, 'back\\slash', 9, current_date - 7, now() - interval '7 days', localtimestamp - interval '7 days',
      '{"n": 5}', '{"n": 5}', '{z}', '{9}', 'nine');
`;

const base: RowsOptions = { pageSize: 50, cursor: null, revealColumns: [] };

describe.skipIf(!testDatabaseUrl())("PostgreSQL getRows with the newer conditions", () => {
  let db: TestDatabase;
  let client: pg.Client;
  let adapter: PostgresAdapter;
  const adv = { schema: "public", name: "adv" };

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    client = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await client.connect();
    await client.query(SQL);
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
  }, 120_000);
  afterAll(async () => {
    await adapter?.disconnect();
    await client?.end().catch(() => {});
    await db?.dispose().catch(() => {});
  });

  /** The ids of the rows a set of conditions keeps, in key order. */
  const ids = async (filters: RowFilter[], extra: Partial<RowsOptions> = {}): Promise<number[]> => {
    const page = await adapter.getRows(adv, { ...base, ...extra, filters });
    return page.rows.map((r) => Number(r[0]!.value));
  };
  const sql = async (where: string): Promise<number[]> =>
    (await client.query(`SELECT id FROM adv WHERE ${where} ORDER BY id`)).rows.map((r) =>
      Number(r.id),
    );

  describe("text", () => {
    it("ends with, ignoring case, and treats % _ and \\ as themselves", async () => {
      expect(await ids([{ column: "name", op: "ends_with", value: "A" }])).toEqual([1, 2, 3, 4, 8]);
      expect(await ids([{ column: "name", op: "ends_with", value: "_x" }])).toEqual([7]);
      expect(await ids([{ column: "name", op: "ends_with", value: "%" }])).toEqual([]);
      expect(await ids([{ column: "name", op: "ends_with", value: "\\slash" }])).toEqual([9]);
      // The empty string is the end of every value that is not NULL.
      expect(await ids([{ column: "name", op: "ends_with", value: "" }])).toEqual(
        await sql("name IS NOT NULL"),
      );
    });

    it("does not contain: a NULL does not contain anything", async () => {
      expect(await ids([{ column: "name", op: "not_contains", value: "a" }])).toEqual(
        await sql("name IS NULL OR strpos(lower(name), 'a') = 0"),
      );
      expect(await ids([{ column: "name", op: "not_contains", value: "a" }])).toContain(6);
    });

    it("matches a pattern, ignoring case, and refuses a pattern that does not compile", async () => {
      expect(await ids([{ column: "name", op: "matches", value: "^al" }])).toEqual([1, 8]);
      expect(await ids([{ column: "name", op: "matches", value: "a$" }])).toEqual([1, 2, 3, 4, 8]);
      expect(await ids([{ column: "name", op: "matches", value: "\\d+%" }])).toEqual([7]);
      await expect(ids([{ column: "name", op: "matches", value: "(" }])).rejects.toMatchObject({
        code: "invalid_request",
      });
      await expect(ids([{ column: "name", op: "matches", value: "[a-" }])).rejects.toMatchObject({
        code: "invalid_request",
      });
    });

    it("is empty: the empty string, not NULL", async () => {
      expect(await ids([{ column: "name", op: "is_empty" }])).toEqual([5]);
    });
  });

  describe("lists and ranges", () => {
    it("in a list, with the values typed by the column", async () => {
      expect(await ids([{ column: "score", op: "in", values: ["1", "3", "9"] }])).toEqual([
        1, 3, 9,
      ]);
      expect(await ids([{ column: "name", op: "in", values: ["alpha", "", "it's"] }])).toEqual([
        1, 5,
      ]);
      await expect(ids([{ column: "score", op: "in", values: ["1", "x"] }])).rejects.toMatchObject({
        code: "invalid_request",
      });
    });

    it("not in a list: a NULL is not in it, so it stays", async () => {
      const kept = await ids([{ column: "score", op: "not_in", values: ["1", "2"] }]);
      expect(kept).toEqual(await sql("score IS DISTINCT FROM 1 AND score IS DISTINCT FROM 2"));
      expect(kept).toContain(4);
    });

    it("between, both ends included", async () => {
      expect(await ids([{ column: "score", op: "between", values: ["2", "5"] }])).toEqual([
        2, 3, 5,
      ]);
      expect(
        await ids([{ column: "born", op: "between", values: ["2000-01-01", "2000-01-02"] }]),
      ).toEqual([]);
      await expect(
        ids([{ column: "score", op: "between", values: ["1", "x"] }]),
      ).rejects.toMatchObject({
        code: "invalid_request",
      });
    });
  });

  describe("the date shortcuts", () => {
    const cases: Array<[string, string, string]> = [
      ["today", "{c}::date = current_date", "today"],
      ["last_7_days", "{c}::date BETWEEN current_date - 6 AND current_date", "the last 7 days"],
      ["last_30_days", "{c}::date BETWEEN current_date - 29 AND current_date", "the last 30 days"],
      ["this_month", "to_char({c}, 'YYYY-MM') = to_char(current_date, 'YYYY-MM')", "this month"],
    ];
    for (const column of ["born", "at", "ts"]) {
      for (const [op, where, label] of cases) {
        it(`${label} on ${column}`, async () => {
          const expected = await sql(where.replaceAll("{c}", column));
          expect(expected.length).toBeGreaterThan(0);
          expect(await ids([{ column, op: op as RowFilter["op"] }])).toEqual(expected);
        });
      }
    }

    it("leaves out a future date and a NULL", async () => {
      const today = await ids([{ column: "born", op: "last_30_days" }]);
      expect(today).not.toContain(7); // tomorrow
      expect(today).not.toContain(5); // no date
    });
  });

  describe("json", () => {
    it("has a key, on jsonb and on json, at the top level only", async () => {
      expect(await ids([{ column: "doc", op: "has_key", value: "k" }])).toEqual([1, 2, 6, 8]);
      expect(await ids([{ column: "doc", op: "has_key", value: "b" }])).toEqual([]); // nested
      expect(await ids([{ column: "jdoc", op: "has_key", value: "k" }])).toEqual([1, 2, 6, 8]);
    });

    it("contains a JSON value", async () => {
      expect(await ids([{ column: "doc", op: "json_contains", value: '{"k": 1}' }])).toEqual([
        1, 8,
      ]);
      expect(
        await ids([{ column: "doc", op: "json_contains", value: '{"a": {"b": [10]}}' }]),
      ).toEqual([1]);
      await expect(ids([{ column: "doc", op: "json_contains", value: "{" }])).rejects.toMatchObject(
        {
          code: "invalid_request",
        },
      );
    });

    it("the value at a path equals a text, through objects and arrays", async () => {
      expect(
        await ids([{ column: "doc", op: "json_path_eq", path: ["a", "b", "1"], value: "20" }]),
      ).toEqual([1]);
      expect(
        await ids([{ column: "doc", op: "json_path_eq", path: ["a", "b", "c"], value: "true" }]),
      ).toEqual([7]);
      expect(await ids([{ column: "doc", op: "json_path_eq", path: ["k"], value: "1" }])).toEqual([
        1, 6, 8,
      ]);
      expect(await ids([{ column: "jdoc", op: "json_path_eq", path: ["n"], value: "5" }])).toEqual([
        9,
      ]);
      // A step with a quote or a brace is a step, not syntax.
      expect(
        await ids([{ column: "doc", op: "json_path_eq", path: ['a"}', "{"], value: "x" }]),
      ).toEqual([]);
    });
  });

  describe("arrays", () => {
    it("contains every value of the list, typed by the array's own element type", async () => {
      expect(await ids([{ column: "nums", op: "array_contains", values: ["3"] }])).toEqual([1, 2]);
      expect(await ids([{ column: "nums", op: "array_contains", values: ["1", "2"] }])).toEqual([
        1,
      ]);
      expect(await ids([{ column: "tags", op: "array_contains", values: ["a,b", 'c"d'] }])).toEqual(
        [6],
      );
      expect(await ids([{ column: "tags", op: "array_contains", values: ["{x}"] }])).toEqual([7]);
      await expect(
        ids([{ column: "nums", op: "array_contains", values: ["x"] }]),
      ).rejects.toMatchObject({
        code: "invalid_request",
      });
    });

    it("overlaps any value of the list", async () => {
      expect(await ids([{ column: "tags", op: "array_overlaps", values: ["z", "x"] }])).toEqual([
        1, 2, 5, 9,
      ]);
    });

    it("is empty: an empty array, not NULL", async () => {
      expect(await ids([{ column: "tags", op: "array_is_empty" }])).toEqual([3]);
      expect(await ids([{ column: "tags", op: "is_null" }])).toEqual([4]);
    });
  });

  describe("groups", () => {
    const A: RowFilter = { column: "score", op: "gte", value: "3" };

    it("conditions with the same group match if any of them does, the rest are all required", async () => {
      const filters: RowFilter[] = [
        A,
        { column: "name", op: "starts_with", value: "al", group: 1 },
        { column: "name", op: "starts_with", value: "ga", group: 1 },
      ];
      expect(await ids(filters)).toEqual([3, 8]);
    });

    it("two groups are each an OR, and joined by AND", async () => {
      const filters: RowFilter[] = [
        { column: "score", op: "lte", value: "2", group: 1 },
        { column: "score", op: "gte", value: "8", group: 1 },
        { column: "name", op: "contains", value: "a", group: 2 },
        { column: "name", op: "is_null", group: 2 },
      ];
      expect(await ids(filters)).toEqual(
        await sql("(score <= 2 OR score >= 8) AND (name ILIKE '%a%' OR name IS NULL)"),
      );
    });

    it("a group of one is the condition itself, and a group may mix kinds of condition", async () => {
      expect(await ids([{ column: "score", op: "eq", value: "5", group: 1 }])).toEqual([5]);
      const mixed: RowFilter[] = [
        { column: "doc", op: "has_key", value: "z", group: 1 },
        { column: "tags", op: "array_is_empty", group: 1 },
        { column: "born", op: "today", group: 1 },
      ];
      expect(await ids(mixed)).toEqual([1, 3]);
    });

    it("pages through a grouped filter with a sort, without skipping or repeating", async () => {
      const filters: RowFilter[] = [
        { column: "score", op: "lte", value: "2", group: 1 },
        { column: "score", op: "gte", value: "6", group: 1 },
        { column: "name", op: "is_not_null" },
      ];
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const page = await adapter.getRows(adv, {
          ...base,
          pageSize: 2,
          cursor,
          filters,
          sort: { column: "score", direction: "desc" },
        });
        seen.push(...page.rows.map((r) => Number(r[0]!.value)));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      expect(seen).toEqual(
        (
          await client.query(
            "SELECT id FROM adv WHERE (score <= 2 OR score >= 6) AND name IS NOT NULL ORDER BY score DESC, id",
          )
        ).rows.map((r) => Number(r.id)),
      );
    });
  });

  describe("what is refused", () => {
    it("an operator the column's kind does not allow", async () => {
      for (const filter of [
        { column: "score", op: "has_key", value: "k" },
        { column: "score", op: "matches", value: "1" },
        { column: "score", op: "today" },
        { column: "name", op: "today" },
        { column: "doc", op: "eq", value: "{}" },
        { column: "doc", op: "contains", value: "k" },
        { column: "tags", op: "in", values: ["x"] },
        { column: "nums", op: "json_contains", value: "[1]" },
      ] as RowFilter[]) {
        await expect(ids([filter]), JSON.stringify(filter)).rejects.toMatchObject({
          code: "invalid_request",
        });
      }
    });

    it("a hidden column, for every new operator: each would read it back", async () => {
      for (const filter of [
        { column: "secret_token", op: "matches", value: "^o" },
        { column: "secret_token", op: "ends_with", value: "e" },
        { column: "secret_token", op: "not_contains", value: "x" },
        { column: "secret_token", op: "in", values: ["one"] },
        { column: "secret_token", op: "between", values: ["a", "p"] },
        { column: "secret_token", op: "is_empty" },
      ] as RowFilter[]) {
        await expect(ids([filter]), filter.op).rejects.toMatchObject({ code: "invalid_request" });
      }
      // Once revealed, the same condition works.
      expect(
        await ids([{ column: "secret_token", op: "matches", value: "^o" }], {
          revealColumns: ["secret_token"],
        }),
      ).toEqual([1]);
    });

    it("never repeats a value or a pattern in the error", async () => {
      try {
        await ids([{ column: "name", op: "matches", value: "SECRET-PATTERN(" }]);
        expect.unreachable();
      } catch (error) {
        expect(String((error as Error).message)).not.toContain("SECRET-PATTERN");
      }
    });
  });
});
