/**
 * Conditions on the rows of a table, against a real PostgreSQL: every operator on every kind of
 * column, case and wildcards, NULL, values that do not fit a type, hidden columns, a table without a
 * key, paging through a filtered and sorted table, and the shorter time limit.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set (see the integration test).
 * Runs in its own throwaway database.
 */
import {
  DatabaseError,
  type RowFilter,
  type RowPage,
  type RowsOptions,
  type TableRef,
} from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

interface Thing {
  id: number;
  name: string | null; // lowercase ASCII only, so the collation and JavaScript agree on the order
  label: string | null; // awkward characters, for contains / starts with / equals
  score: number | null;
  mood: string | null;
  born: string | null;
  ok: boolean | null;
  amount: number | null;
}

const THINGS: Thing[] = [
  {
    id: 1,
    name: "bob",
    label: "Ann",
    score: 5,
    mood: "ok",
    born: "2020-01-03",
    ok: true,
    amount: 5,
  },
  {
    id: 2,
    name: "ann",
    label: "ANNIE",
    score: 5,
    mood: "sad",
    born: "2020-01-01",
    ok: false,
    amount: 2.5,
  },
  { id: 3, name: null, label: "a%b", score: 3, mood: "happy", born: null, ok: null, amount: null },
  {
    id: 4,
    name: "cat",
    label: "axb",
    score: null,
    mood: null,
    born: "2020-01-02",
    ok: true,
    amount: 10,
  },
  {
    id: 5,
    name: "",
    label: "a_b",
    score: 9,
    mood: "sad",
    born: "2019-12-31",
    ok: false,
    amount: 0.5,
  },
  {
    id: 6,
    name: "bob",
    label: "back\\slash",
    score: 3,
    mood: "ok",
    born: "2020-01-03",
    ok: null,
    amount: 100,
  },
  { id: 7, name: null, label: null, score: null, mood: null, born: null, ok: null, amount: null },
  {
    id: 8,
    name: "dan",
    label: "it's",
    score: 10,
    mood: "happy",
    born: "2020-02-01",
    ok: true,
    amount: 7.25,
  },
  {
    id: 9,
    name: "ann",
    label: "50% off",
    score: 2,
    mood: "ok",
    born: "2020-01-01",
    ok: false,
    amount: 1,
  },
  {
    id: 10,
    name: "eve",
    label: "",
    score: 10,
    mood: "sad",
    born: "2020-03-01",
    ok: true,
    amount: 9,
  },
  {
    id: 11,
    name: "zed",
    label: "Zed",
    score: 1,
    mood: "happy",
    born: "2020-01-02",
    ok: false,
    amount: 3,
  },
  { id: 12, name: "bob", label: "ann", score: 5, mood: "sad", born: null, ok: null, amount: 4 },
];
const MOODS = ["sad", "ok", "happy"]; // declaration order

const literal = (value: string | number | boolean | null): string =>
  value === null
    ? "NULL"
    : typeof value === "string"
      ? `'${value.replace(/'/g, "''")}'`
      : String(value);

const SQL = `
  CREATE TYPE f_mood AS ENUM ('sad', 'ok', 'happy');
  CREATE TABLE things (
    id integer PRIMARY KEY, name text, label text, score integer, mood f_mood, born date,
    ok boolean, amount numeric, data jsonb, password_hash text
  );
  INSERT INTO things (id, name, label, score, mood, born, ok, amount, password_hash) VALUES
    ${THINGS.map((t) => `(${[t.id, t.name, t.label, t.score, t.mood, t.born, t.ok, t.amount].map(literal).join(", ")}, 'hash-' || ${t.id})`).join(",\n    ")};

  CREATE TABLE nokey (v integer, w text);
  INSERT INTO nokey SELECT i, 'w' || i FROM generate_series(1, 5) AS i;

  -- 101 columns: the last one is not among the 100 that are read
  CREATE TABLE wide (${Array.from({ length: 101 }, (_, i) => `c${i} integer`).join(", ")});
  INSERT INTO wide (c0, c100) VALUES (1, 5);

  CREATE TABLE locked_f (id integer PRIMARY KEY, name text);
  INSERT INTO locked_f VALUES (1, 'a'), (2, 'b');
`;

const first: RowsOptions = { pageSize: 50, cursor: null, revealColumns: [] };

describe.skipIf(!testDatabaseUrl())("PostgreSQL getRows with conditions", () => {
  let db: TestDatabase;
  let adapter: PostgresAdapter;

  const ref = (name: string): TableRef => ({ schema: "public", name });
  const read = (name: string, options: Partial<RowsOptions> = {}): Promise<RowPage> =>
    adapter.getRows(ref(name), { ...first, ...options });

  /** The ids the read gives for these conditions (table `things`, one big page, in key order unless sorted). */
  async function idsFor(
    filters: RowFilter[],
    options: Partial<RowsOptions> = {},
  ): Promise<string[]> {
    const page = await read("things", { ...options, filters });
    return page.rows.map((r) => r[0]!.value!);
  }
  const ids = (predicate: (t: Thing) => boolean): string[] =>
    THINGS.filter(predicate).map((t) => String(t.id));

  async function expectMatch(
    filters: RowFilter[],
    predicate: (t: Thing) => boolean,
  ): Promise<void> {
    expect(await idsFor(filters), JSON.stringify(filters)).toEqual(ids(predicate));
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    const client = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await client.connect();
    try {
      await client.query(SQL);
    } finally {
      await client.end();
    }
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
  }, 60_000);

  afterAll(async () => {
    await adapter?.disconnect();
    await db?.dispose();
  });

  describe("text", () => {
    it("equals is exact, case included, and the empty string is not NULL", async () => {
      await expectMatch([{ column: "label", op: "eq", value: "Ann" }], (t) => t.label === "Ann");
      await expectMatch([{ column: "label", op: "eq", value: "ann" }], (t) => t.label === "ann");
      await expectMatch([{ column: "label", op: "eq", value: "" }], (t) => t.label === "");
    });

    it("not equals also matches NULL (a NULL is distinct from any value)", async () => {
      await expectMatch([{ column: "label", op: "neq", value: "Ann" }], (t) => t.label !== "Ann");
      expect(await idsFor([{ column: "label", op: "neq", value: "Ann" }])).toContain("7");
    });

    it("contains ignores case, and a part of the value is enough", async () => {
      await expectMatch(
        [{ column: "label", op: "contains", value: "ann" }],
        (t) => t.label !== null && t.label.toLowerCase().includes("ann"),
      );
      expect(await idsFor([{ column: "label", op: "contains", value: "ANN" }])).toEqual([
        "1",
        "2",
        "12",
      ]);
    });

    it("starts with ignores case too", async () => {
      await expectMatch(
        [{ column: "label", op: "starts_with", value: "a" }],
        (t) => t.label !== null && t.label.toLowerCase().startsWith("a"),
      );
      expect(await idsFor([{ column: "label", op: "starts_with", value: "A" }])).toEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
        "12",
      ]);
    });

    it.each([
      ["%", ["3", "9"]],
      ["_", ["5"]],
      ["\\", ["6"]],
      ["'", ["8"]],
      ["50%", ["9"]],
      ["a%b", ["3"]],
    ])("treats %j as a character, not a pattern, in contains", async (value, expected) => {
      expect(await idsFor([{ column: "label", op: "contains", value }])).toEqual(expected);
    });

    it("treats % and _ as characters in starts with, and an empty value matches every non-NULL value", async () => {
      expect(await idsFor([{ column: "label", op: "starts_with", value: "%" }])).toEqual([]);
      expect(await idsFor([{ column: "label", op: "starts_with", value: "_" }])).toEqual([]);
      const nonNull = ids((t) => t.label !== null);
      expect(await idsFor([{ column: "label", op: "contains", value: "" }])).toEqual(nonNull);
      expect(await idsFor([{ column: "label", op: "starts_with", value: "" }])).toEqual(nonNull);
    });

    it("compares text in the database's order", async () => {
      await expectMatch(
        [{ column: "name", op: "gt", value: "bob" }],
        (t) => t.name !== null && t.name > "bob",
      );
      await expectMatch(
        [{ column: "name", op: "lte", value: "bob" }],
        (t) => t.name !== null && t.name <= "bob",
      );
    });
  });

  describe("numbers, dates, booleans and enums", () => {
    it("compares an integer as a number: 9 comes before 10", async () => {
      await expectMatch(
        [{ column: "score", op: "gt", value: "9" }],
        (t) => t.score !== null && t.score > 9,
      );
      await expectMatch(
        [{ column: "score", op: "gte", value: "9" }],
        (t) => t.score !== null && t.score >= 9,
      );
      await expectMatch(
        [{ column: "score", op: "lt", value: "3" }],
        (t) => t.score !== null && t.score < 3,
      );
      await expectMatch(
        [{ column: "score", op: "lte", value: "3" }],
        (t) => t.score !== null && t.score <= 3,
      );
      await expectMatch([{ column: "score", op: "eq", value: "5" }], (t) => t.score === 5);
      await expectMatch([{ column: "score", op: "neq", value: "5" }], (t) => t.score !== 5);
    });

    it("compares a numeric by value, not by how it is written", async () => {
      await expectMatch([{ column: "amount", op: "eq", value: "5.000" }], (t) => t.amount === 5);
      await expectMatch(
        [{ column: "amount", op: "gt", value: "7" }],
        (t) => t.amount !== null && t.amount > 7,
      );
    });

    it("compares dates, booleans and an enum in its declared order", async () => {
      await expectMatch(
        [{ column: "born", op: "gt", value: "2020-01-02" }],
        (t) => t.born !== null && t.born > "2020-01-02",
      );
      await expectMatch([{ column: "ok", op: "eq", value: "true" }], (t) => t.ok === true);
      await expectMatch([{ column: "ok", op: "neq", value: "true" }], (t) => t.ok !== true);
      await expectMatch([{ column: "mood", op: "eq", value: "sad" }], (t) => t.mood === "sad");
      // happy comes after ok comes after sad, as declared: not alphabetical.
      await expectMatch(
        [{ column: "mood", op: "gt", value: "ok" }],
        (t) => t.mood !== null && MOODS.indexOf(t.mood) > MOODS.indexOf("ok"),
      );
    });

    it("tests for NULL on every kind of column, including one with no order at all", async () => {
      await expectMatch([{ column: "score", op: "is_null" }], (t) => t.score === null);
      await expectMatch([{ column: "born", op: "is_not_null" }], (t) => t.born !== null);
      // `data` is jsonb: kind "other", only the null tests. It is NULL in every row.
      expect(await idsFor([{ column: "data", op: "is_null" }])).toEqual(ids(() => true));
      expect(await idsFor([{ column: "data", op: "is_not_null" }])).toEqual([]);
    });
  });

  describe("combining conditions", () => {
    it("requires every condition", async () => {
      await expectMatch(
        [
          { column: "score", op: "gte", value: "3" },
          { column: "label", op: "contains", value: "a" },
          { column: "ok", op: "is_not_null" },
        ],
        (t) =>
          t.score !== null &&
          t.score >= 3 &&
          t.label !== null &&
          t.label.toLowerCase().includes("a") &&
          t.ok !== null,
      );
    });

    it("allows two conditions on one column, as a range", async () => {
      await expectMatch(
        [
          { column: "score", op: "gte", value: "3" },
          { column: "score", op: "lte", value: "5" },
        ],
        (t) => t.score !== null && t.score >= 3 && t.score <= 5,
      );
    });

    it("echoes the conditions, and says so when nothing matches", async () => {
      const filters: RowFilter[] = [{ column: "name", op: "eq", value: "nobody" }];
      const page = await read("things", { filters });
      expect(page.filters).toEqual(filters);
      expect(page.rows).toEqual([]);
      expect(page.columns.length).toBeGreaterThan(5);
      expect(page.nextCursor).toBeNull();
    });
  });

  describe("paging a filtered table", () => {
    it.each([1, 2, 3, 5])(
      "visits each matching row once at %i per page, sorted or not, in the order of one big page",
      async (pageSize) => {
        const filters: RowFilter[] = [
          { column: "score", op: "is_not_null" },
          { column: "label", op: "neq", value: "ann" },
        ];
        for (const sort of [
          null,
          { column: "score", direction: "desc" as const },
          { column: "name", direction: "asc" as const },
        ]) {
          const whole = (await read("things", { filters, sort, pageSize: 50 })).rows.map(
            (r) => r[0]!.value,
          );
          const seen: Array<string | null> = [];
          let cursor: string | null = null;
          for (let guard = 0; guard < 50; guard += 1) {
            const page: RowPage = await read("things", { filters, sort, pageSize, cursor });
            seen.push(...page.rows.map((r) => r[0]!.value));
            cursor = page.nextCursor;
            if (cursor === null) break;
          }
          expect(seen, JSON.stringify(sort)).toEqual(whole);
          expect(new Set(seen).size).toBe(whole.length);
          expect(whole.length).toBeGreaterThan(3);
        }
      },
    );

    it("filters a table without a key, paged by position", async () => {
      const seen: Array<string | null> = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page: RowPage = await read("nokey", {
          pageSize: 2,
          cursor,
          filters: [{ column: "v", op: "gt", value: "2" }],
        });
        seen.push(...page.rows.map((r) => r[0]!.value));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      expect(seen.sort()).toEqual(["3", "4", "5"]);
      const text = await read("nokey", {
        filters: [{ column: "w", op: "starts_with", value: "W4" }],
      });
      expect(text.rows.map((r) => r[0]!.value)).toEqual(["4"]);
    });
  });

  describe("refusals", () => {
    const one = (filter: RowFilter): Partial<RowsOptions> => ({ filters: [filter] });

    it("a hidden column, until it is revealed: a condition on it would read it back", async () => {
      await expect(
        read("things", one({ column: "password_hash", op: "starts_with", value: "hash-1" })),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        read("things", one({ column: "password_hash", op: "is_null" })),
      ).rejects.toMatchObject({ code: "invalid_request" });
      const page = await read("things", {
        ...one({ column: "password_hash", op: "starts_with", value: "hash-1" }),
        revealColumns: ["password_hash"],
      });
      expect(page.rows.map((r) => r[0]!.value)).toEqual(["1", "10", "11", "12"]);
    });

    it("an operator the column's kind does not allow", async () => {
      for (const filter of [
        { column: "score", op: "contains", value: "1" },
        { column: "mood", op: "starts_with", value: "s" },
        { column: "data", op: "eq", value: "{}" },
        { column: "data", op: "gt", value: "{}" },
      ] as RowFilter[]) {
        await expect(read("things", one(filter)), JSON.stringify(filter)).rejects.toMatchObject({
          code: "invalid_request",
        });
      }
    });

    it("a column that does not exist, and a column that is not among the first 100 that are read", async () => {
      await expect(read("things", one({ column: "nope", op: "is_null" }))).rejects.toMatchObject({
        code: "invalid_request",
      });
      const wide = await read("wide", one({ column: "c0", op: "eq", value: "1" }));
      expect(wide.rows).toHaveLength(1);
      expect(wide.hiddenColumns).toBe(1);
      await expect(
        read("wide", one({ column: "c100", op: "eq", value: "5" })),
      ).rejects.toMatchObject({
        code: "invalid_request",
      });
    });

    it("more than ten conditions", async () => {
      const filter: RowFilter = { column: "score", op: "gte", value: "0" };
      expect(
        (await read("things", { filters: Array(10).fill(filter) })).rows.length,
      ).toBeGreaterThan(0);
      await expect(read("things", { filters: Array(11).fill(filter) })).rejects.toMatchObject({
        code: "invalid_request",
      });
    });

    it.each([
      ["an integer", { column: "score", op: "eq", value: "FORGED-FILTER-VALUE" }],
      ["an integer written as a decimal", { column: "score", op: "eq", value: "5.0" }],
      ["a date", { column: "born", op: "gt", value: "FORGED-FILTER-VALUE" }],
      ["a boolean", { column: "ok", op: "eq", value: "FORGED-FILTER-VALUE" }],
      [
        "an enum label that does not exist",
        { column: "mood", op: "eq", value: "FORGED-FILTER-VALUE" },
      ],
    ] as const)(
      "a value that does not fit %s gets a fixed message that never repeats it",
      async (_name, filter) => {
        try {
          await read("things", one(filter as RowFilter));
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(DatabaseError);
          expect((error as DatabaseError).code).toBe("invalid_request");
          expect((error as DatabaseError).message).not.toContain("FORGED-FILTER-VALUE");
        }
      },
    );

    it("SQL in a value is only a value: nothing is injected and the table is untouched", async () => {
      for (const op of ["eq", "contains", "starts_with", "neq"] as const) {
        const page = await read(
          "things",
          one({ column: "name", op, value: "x'; DROP TABLE things; --" }),
        );
        expect(page.rows.length).toBe(op === "neq" ? 12 : 0);
      }
      expect(
        (await read("things", one({ column: "label", op: "contains", value: "' OR '1'='1" }))).rows,
      ).toEqual([]);
      expect((await read("things")).rows).toHaveLength(12);
    });
  });

  describe("the shorter time limit", () => {
    it("a filtered read that runs out of time is too_slow", async () => {
      const { host, port, username, password } = db.connection;
      const locker = new pg.Client({ host, port, user: username, password, database: db.dbName });
      await locker.connect();
      const impatient = new PostgresAdapter(db.connection, { statementTimeoutMs: 700 });
      await impatient.connect();
      try {
        await locker.query("BEGIN");
        await locker.query("LOCK TABLE locked_f IN ACCESS EXCLUSIVE MODE");
        const result = await impatient
          .getRows(ref("locked_f"), {
            ...first,
            filters: [{ column: "name", op: "eq", value: "a" }],
          })
          .catch((e: unknown) => e);
        expect(result).toBeInstanceOf(DatabaseError);
        expect((result as DatabaseError).code).toBe("too_slow");
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        await locker.end();
      }
      try {
        const page = await impatient.getRows(ref("locked_f"), {
          ...first,
          filters: [{ column: "name", op: "eq", value: "a" }],
        });
        expect(page.rows.map((r) => r[0]!.value)).toEqual(["1"]);
      } finally {
        await impatient.disconnect();
      }
    }, 30_000);
  });
});
