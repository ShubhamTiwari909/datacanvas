/**
 * Sorting the rows of a table, against a real PostgreSQL: which columns can be
 * sorted, NULLs and ties, paging through every page of a sorted table (each row
 * exactly once), the refusals, a value too long to continue from, and the shorter
 * time limit.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set (see the integration test).
 * Runs in its own throwaway database.
 */
import {
  DatabaseError,
  ROWS_MAX_SORT_VALUE_CHARS,
  encodeRowsCursor,
  type RowPage,
  type RowSort,
  type RowsOptions,
  type TableRef,
} from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import {
  createTestDatabase,
  quoteIdent,
  testDatabaseUrl,
  type TestDatabase,
} from "./testing/index.js";

type Person = {
  id: number;
  name: string | null;
  score: number | null;
  mood: string | null;
  born: string | null;
  ok: boolean | null;
};

// Lowercase ASCII names only, so the database's collation and JavaScript agree on the order.
const PEOPLE: Person[] = [
  { id: 1, name: "bob", score: 5, mood: "ok", born: "2020-01-03", ok: true },
  { id: 2, name: "ann", score: 5, mood: "sad", born: "2020-01-01", ok: false },
  { id: 3, name: null, score: 3, mood: "happy", born: null, ok: null },
  { id: 4, name: "cat", score: null, mood: null, born: "2020-01-02", ok: true },
  { id: 5, name: "", score: 9, mood: "sad", born: "2019-12-31", ok: false },
  { id: 6, name: "bob", score: 3, mood: "ok", born: "2020-01-03", ok: null },
  { id: 7, name: null, score: null, mood: null, born: null, ok: null },
  { id: 8, name: "dan", score: 10, mood: "happy", born: "2020-02-01", ok: true },
  { id: 9, name: "ann", score: 2, mood: "ok", born: "2020-01-01", ok: false },
  { id: 10, name: "eve", score: 10, mood: "sad", born: "2020-03-01", ok: true },
  { id: 11, name: "zed", score: 1, mood: "happy", born: "2020-01-02", ok: false },
  { id: 12, name: "bob", score: 5, mood: "sad", born: null, ok: null },
];

const MOODS = ["sad", "ok", "happy"]; // the order the enum was declared in, not alphabetical

const literal = (value: string | number | boolean | null): string =>
  value === null
    ? "NULL"
    : typeof value === "string"
      ? `'${value.replace(/'/g, "''")}'`
      : String(value);

const SQL = `
  CREATE TYPE s_mood AS ENUM ('sad', 'ok', 'happy');
  CREATE DOMAIN s_text AS text;
  CREATE DOMAIN s_text2 AS s_text;
  CREATE DOMAIN s_int AS integer;

  CREATE TABLE people (
    id integer PRIMARY KEY, name text, score integer, mood s_mood, born date, ok boolean,
    tag varchar(10), amount numeric, dom s_text2, domint s_int, span int4range, at timestamptz,
    data jsonb, raw bytea, tags text[], loc point, doc json, password_hash text
  );
  INSERT INTO people (id, name, score, mood, born, ok, password_hash) VALUES
    ${PEOPLE.map((p) => `(${[p.id, p.name, p.score, p.mood, p.born, p.ok].map(literal).join(", ")}, 'hash-' || ${p.id})`).join(",\n    ")};

  -- a composite primary key, with ties in the sort column
  CREATE TABLE pair (a integer, b text, c integer, PRIMARY KEY (a, b));
  INSERT INTO pair SELECT i % 4, 'k' || i, (i * 7) % 5 FROM generate_series(1, 30) AS i;
  INSERT INTO pair (a, b, c) SELECT 100 + i, 'n' || i, NULL FROM generate_series(1, 5) AS i;

  -- a unique index instead of a primary key
  CREATE TABLE uq (email text NOT NULL UNIQUE, v integer);
  INSERT INTO uq SELECT 'u' || lpad(i::text, 3, '0'), (i * 3) % 7 FROM generate_series(1, 25) AS i;

  -- no key at all, and a materialized view (never keyed)
  CREATE TABLE nokey (v integer);
  INSERT INTO nokey SELECT i FROM generate_series(1, 5) AS i;
  CREATE MATERIALIZED VIEW mv AS SELECT id, name FROM people;

  -- long values in the sort column
  CREATE TABLE longs (id integer PRIMARY KEY, v text);
  INSERT INTO longs VALUES
    (1, repeat('a', ${ROWS_MAX_SORT_VALUE_CHARS})),
    (2, repeat('b', ${ROWS_MAX_SORT_VALUE_CHARS})),
    (3, repeat('c', ${ROWS_MAX_SORT_VALUE_CHARS + 1})),
    (4, repeat('d', ${ROWS_MAX_SORT_VALUE_CHARS + 1}));

  -- read while another session holds a lock, to run into the time limit
  CREATE TABLE locked_t (id integer PRIMARY KEY, name text);
  INSERT INTO locked_t VALUES (1, 'a'), (2, 'b');
`;

const first: RowsOptions = { pageSize: 50, cursor: null, revealColumns: [], sort: null };

describe.skipIf(!testDatabaseUrl())("PostgresAdapter.getRows with a sort", () => {
  let db: TestDatabase;
  let adapter: PostgresAdapter;

  const ref = (name: string): TableRef => ({ schema: "public", name });
  const read = (name: string, options: Partial<RowsOptions> = {}): Promise<RowPage> =>
    adapter.getRows(ref(name), { ...first, ...options });

  /** Every page of a sorted table, read to the end: the value of one column of every row, in the order read. */
  async function walk(
    name: string,
    sort: RowSort,
    pageSize: number,
    column: string,
    options: Partial<RowsOptions> = {},
  ): Promise<Array<string | null>> {
    const seen: Array<string | null> = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 1000; guard += 1) {
      const page: RowPage = await read(name, { ...options, pageSize, cursor, sort });
      const index = page.columns.findIndex((c) => c.name === column);
      seen.push(...page.rows.map((r) => r[index]!.value));
      cursor = page.nextCursor;
      if (cursor === null) return seen;
    }
    throw new Error("paging did not end");
  }

  /** The ids of PEOPLE in the order the database should give: NULL last when ascending, first when descending; the id breaks ties. */
  function expectedIds(
    rank: (p: Person) => number | string | null,
    direction: "asc" | "desc",
  ): string[] {
    const compare = (a: Person, b: Person): number => {
      const x = rank(a);
      const y = rank(b);
      let result: number;
      if (x === null || y === null) result = x === y ? 0 : x === null ? 1 : -1;
      else result = x < y ? -1 : x > y ? 1 : 0;
      return (direction === "asc" ? result : -result) || a.id - b.id;
    };
    return [...PEOPLE].sort(compare).map((p) => String(p.id));
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

  describe("which columns can be sorted", () => {
    it("classifies every column by what its values can do", async () => {
      const page = await read("people", { revealColumns: ["password_hash"] });
      const kinds = Object.fromEntries(page.columns.map((c) => [c.name, c.kind]));
      expect(kinds).toEqual({
        id: "ordered",
        name: "text",
        score: "ordered",
        mood: "ordered", // an enum
        born: "ordered",
        ok: "ordered",
        tag: "text", // varchar
        amount: "ordered",
        dom: "text", // a domain over a domain over text
        domint: "ordered", // a domain over integer
        span: "ordered", // a range
        at: "ordered",
        data: "json", // jsonb has a btree order, but it means nothing to a person: it is searched, not sorted
        raw: "other", // bytea likewise
        tags: "array", // an array
        loc: "other", // no btree order at all
        doc: "json", // json has none either
        password_hash: "text",
      });
    });

    it.each(["data", "raw", "tags", "loc", "doc"])(
      "refuses to sort by the %s column",
      async (column) => {
        await expect(read("people", { sort: { column, direction: "asc" } })).rejects.toMatchObject({
          code: "invalid_request",
        });
      },
    );
  });

  describe("order, NULLs and ties", () => {
    it("sorts ascending with NULL last, and the key breaking ties", async () => {
      const ids = await walk("people", { column: "score", direction: "asc" }, 50, "id");
      expect(ids).toEqual(expectedIds((p) => p.score, "asc"));
      // A number sorts as a number (9 before 10), not as text.
      expect(ids.indexOf("5")).toBeLessThan(ids.indexOf("8"));
    });

    it("sorts descending with NULL first", async () => {
      const ids = await walk("people", { column: "score", direction: "desc" }, 50, "id");
      expect(ids).toEqual(expectedIds((p) => p.score, "desc"));
      expect(ids.slice(0, 2)).toEqual(["4", "7"]);
    });

    it("puts the empty string before every other text and apart from NULL", async () => {
      const ids = await walk("people", { column: "name", direction: "asc" }, 50, "id");
      expect(ids).toEqual(expectedIds((p) => p.name, "asc"));
      expect(ids[0]).toBe("5"); // '' first
      expect(ids.slice(-2)).toEqual(["3", "7"]); // NULLs last
    });

    it.each([
      ["a text column", "name", (p: Person) => p.name],
      ["a number", "score", (p: Person) => p.score],
      ["a date", "born", (p: Person) => p.born],
      ["a boolean", "ok", (p: Person) => (p.ok === null ? null : p.ok ? 1 : 0)],
      [
        "an enum, in the order it was declared",
        "mood",
        (p: Person) => (p.mood === null ? null : MOODS.indexOf(p.mood)),
      ],
      ["the primary key itself", "id", (p: Person) => p.id],
    ] as const)("sorts by %s in both directions", async (_label, column, rank) => {
      for (const direction of ["asc", "desc"] as const) {
        const ids = await walk("people", { column, direction }, 50, "id");
        expect(ids, `${column} ${direction}`).toEqual(expectedIds(rank, direction));
      }
    });
  });

  describe("paging through a sorted table", () => {
    it.each([1, 2, 3, 5, 7, 11, 12, 13])(
      "visits every row exactly once at %i rows per page, in the same order as one big page",
      async (pageSize) => {
        for (const column of ["score", "name", "born", "mood"]) {
          for (const direction of ["asc", "desc"] as const) {
            const sort = { column, direction };
            const whole = await walk("people", sort, 50, "id");
            const paged = await walk("people", sort, pageSize, "id");
            expect(paged, `${column} ${direction}`).toEqual(whole);
            expect(new Set(paged).size).toBe(PEOPLE.length);
          }
        }
      },
    );

    it("pages a composite primary key sorted by a column with many ties and NULLs", async () => {
      for (const direction of ["asc", "desc"] as const) {
        const sort = { column: "c", direction };
        const whole = await walk("pair", sort, 200, "b");
        for (const size of [1, 2, 3, 4, 7]) {
          expect(await walk("pair", sort, size, "b"), `${direction} ${size}`).toEqual(whole);
        }
        expect(new Set(whole).size).toBe(35);
      }
    });

    it("pages a table whose key is a unique index", async () => {
      const page = await read("uq", { sort: { column: "v", direction: "desc" }, pageSize: 4 });
      expect(page.order.kind).toBe("unique_index");
      const whole = await walk("uq", { column: "v", direction: "desc" }, 200, "email");
      expect(await walk("uq", { column: "v", direction: "desc" }, 4, "email")).toEqual(whole);
      expect(new Set(whole).size).toBe(25);
    });

    it("echoes the sort, and the key order still describes the tie-breaker", async () => {
      const page = await read("people", {
        sort: { column: "name", direction: "desc" },
        pageSize: 3,
      });
      expect(page.sort).toEqual({ column: "name", direction: "desc" });
      expect(page.order).toEqual({ kind: "primary_key", columns: ["id"] });
      expect(page.nextCursor).not.toBeNull();
      expect((await read("people")).sort).toBeNull();
    });
  });

  describe("refusals", () => {
    const sortBy = (column: string): Partial<RowsOptions> => ({
      sort: { column, direction: "asc" },
    });

    it("a column that does not exist", async () => {
      await expect(read("people", sortBy("nope"))).rejects.toMatchObject({
        code: "invalid_request",
      });
    });

    it("a hidden column, until it is revealed: ordering by it would read it back", async () => {
      await expect(read("people", sortBy("password_hash"))).rejects.toMatchObject({
        code: "invalid_request",
      });
      const page = await read("people", {
        ...sortBy("password_hash"),
        revealColumns: ["password_hash"],
      });
      expect(page.rows.length).toBe(12);
    });

    it("a table without a key, and a materialized view", async () => {
      await expect(read("nokey", sortBy("v"))).rejects.toMatchObject({ code: "invalid_request" });
      await expect(read("mv", sortBy("name"))).rejects.toMatchObject({ code: "invalid_request" });
    });

    it("a cursor made without the sort, and a cursor made with one on an unsorted read", async () => {
      const plain = await read("people", { pageSize: 3 });
      await expect(
        read("people", { cursor: plain.nextCursor, sort: { column: "score", direction: "asc" } }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      const sorted = await read("people", {
        pageSize: 3,
        sort: { column: "score", direction: "asc" },
      });
      await expect(read("people", { cursor: sorted.nextCursor })).rejects.toMatchObject({
        code: "invalid_request",
      });
    });

    it("a forged sort value gets a fixed message that does not repeat it", async () => {
      const forged = "not-a-number-FORGED-SECRET";
      const cursor = encodeRowsCursor({ kind: "keyset", values: ["1"], sort: { value: forged } });
      try {
        await read("people", { cursor, sort: { column: "score", direction: "asc" } });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseError);
        expect((error as DatabaseError).code).toBe("invalid_request");
        expect((error as DatabaseError).message).not.toContain(forged);
        expect(String((error as { cause?: unknown }).cause?.toString?.() ?? "")).toContain("");
      }
    });

    it("a sort value that is only a parameter: SQL in it changes nothing", async () => {
      const cursor = encodeRowsCursor({
        kind: "keyset",
        values: ["1"],
        sort: { value: "x'; DROP TABLE people; --" },
      });
      // Not a valid integer, so it is refused as a bad value; the table is untouched either way.
      await expect(
        read("people", { cursor, sort: { column: "score", direction: "asc" } }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect((await read("people")).rows.length).toBe(12);
      // On a text column the same text is just a value to compare with.
      const text = await read("people", { cursor, sort: { column: "name", direction: "asc" } });
      expect(text.rows.length).toBeGreaterThan(0);
    });
  });

  describe("a value too long to continue from", () => {
    it("pages while the last value fits, and stops with a flag when it does not", async () => {
      const sort = { column: "v", direction: "asc" as const };
      // Rows 1 and 2 hold exactly the limit: paging works across them.
      const a = await read("longs", { pageSize: 1, sort });
      expect(a.sortValueTooLong).toBe(false);
      expect(a.nextCursor).not.toBeNull();
      const b = await read("longs", { pageSize: 1, sort, cursor: a.nextCursor });
      expect(b.rows[0]![0]!.value).toBe("2");
      // Row 3 holds one character more than a cursor can carry: the page ends there.
      const c = await read("longs", { pageSize: 1, sort, cursor: b.nextCursor });
      expect(c.rows[0]![0]!.value).toBe("3");
      expect(c.nextCursor).toBeNull();
      expect(c.sortValueTooLong).toBe(true);
    });
  });

  describe("the shorter time limit", () => {
    async function holdLock<T>(work: () => Promise<T>): Promise<T> {
      const { host, port, username, password } = db.connection;
      const locker = new pg.Client({ host, port, user: username, password, database: db.dbName });
      await locker.connect();
      try {
        await locker.query("BEGIN");
        await locker.query("LOCK TABLE locked_t IN ACCESS EXCLUSIVE MODE");
        return await work();
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        await locker.end();
      }
    }

    it("a sorted read that runs out of time is too_slow, a plain one is a timeout, and the adapter works afterwards", async () => {
      const impatient = new PostgresAdapter(db.connection, { statementTimeoutMs: 700 });
      await impatient.connect();
      try {
        await holdLock(async () => {
          const sorted = await impatient
            .getRows(ref("locked_t"), { ...first, sort: { column: "name", direction: "asc" } })
            .catch((e: unknown) => e);
          expect(sorted).toBeInstanceOf(DatabaseError);
          expect((sorted as DatabaseError).code).toBe("too_slow");
          expect((sorted as DatabaseError).message).toMatch(/5 seconds/);

          const plain = await impatient.getRows(ref("locked_t"), first).catch((e: unknown) => e);
          expect((plain as DatabaseError).code).toBe("timeout");
        });
        // The lock is gone and the connection was not left in a bad state.
        const page = await impatient.getRows(ref("locked_t"), {
          ...first,
          sort: { column: "name", direction: "desc" },
        });
        expect(page.rows.map((r) => r[1]!.value)).toEqual(["b", "a"]);
      } finally {
        await impatient.disconnect();
      }
    }, 30_000);
  });

  it("every table name in this file is quoted by the helper, not pasted", () => {
    expect(quoteIdent("people")).toBe('"people"');
  });
});
