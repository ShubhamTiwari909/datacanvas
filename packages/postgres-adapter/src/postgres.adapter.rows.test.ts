/**
 * `getRows()` against a real PostgreSQL: the values of every kind of type read
 * as text, truncation, keys and paging, masking, the kinds of table, row-level
 * security, permissions, and that no error ever repeats a value.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set (see the integration test).
 * Runs in its own throwaway database. A throwaway role is created (and dropped)
 * for the permission and row-level-security tests.
 */
import {
  ROWS_CELL_CHARS,
  ROWS_MAX_COLUMNS,
  ROWS_MAX_OFFSET,
  ROWS_MAX_RESPONSE_CHARS,
  encodeRowsCursor,
  type RowPage,
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

const LONG_KEY = (i: number): string => `${"k".repeat(2300)}${i}`;
const SECRET = "hunter2-SECRET-VALUE";

const SQL = `
  CREATE TYPE rows_mood AS ENUM ('sad', 'ok');
  CREATE DOMAIN rows_posint AS integer CHECK (VALUE > 0);

  -- every kind of type, read back as text
  CREATE TABLE typed (
    id bigint PRIMARY KEY, n numeric(10,2), f double precision, b boolean, d date,
    ts timestamptz, iv interval, u uuid, j jsonb, ba bytea, ip inet, e rows_mood,
    dm rows_posint, arr integer[], r int4range, t text
  );
  SET TIME ZONE 'UTC';
  INSERT INTO typed VALUES
    (1, 12.50, 0.1, true, '2026-11-16', '2026-11-16 10:00:00+00', '1 day 2 hours',
     'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '{"a": [1, 2]}', '\\xdeadbeef', '10.0.0.1/24',
     'ok', 5, '{1,2,3}', '[1,10)', 'plain'),
    (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ''),
    (3, -0.01, 1e300, false, 'infinity', 'infinity', '-1 year', NULL, 'null', '\\x', '::1', 'sad', 1, '{}', 'empty', 'it''s "quoted"');

  -- values far longer than the cell limit
  CREATE TABLE big (id serial PRIMARY KEY, t text);
  INSERT INTO big (t) VALUES
    (repeat('x', 3000) || 'TAIL'),
    (repeat('y', 1000000)),
    (repeat('a', 1999) || '🙂' || 'zz'),
    (repeat('b', 2000)),
    (repeat('c', 2001));

  -- a key longer than the cell limit: the paging position must be the real key
  CREATE TABLE longkey (k text PRIMARY KEY, v int);
  INSERT INTO longkey SELECT repeat('k', 2300) || i, i FROM generate_series(1, 5) i;

  -- composite key
  CREATE TABLE composite (a int, b text, v text, PRIMARY KEY (a, b));
  INSERT INTO composite VALUES (1,'a','1a'),(1,'b','1b'),(2,'a','2a'),(2,'b','2b'),(3,'z','3z');

  -- no key at all, and keys that must NOT be used
  CREATE TABLE nokey (v text);
  INSERT INTO nokey SELECT 'row' || i FROM generate_series(1, 7) i;
  CREATE TABLE unique_notnull (a int NOT NULL, b text);
  CREATE UNIQUE INDEX unique_notnull_a ON unique_notnull (a);
  INSERT INTO unique_notnull VALUES (3,'c'),(1,'a'),(2,'b');
  CREATE TABLE partial_only (a int NOT NULL, b text);
  CREATE UNIQUE INDEX partial_only_a ON partial_only (a) WHERE b IS NOT NULL;
  CREATE TABLE nullable_unique (a int, b text);
  CREATE UNIQUE INDEX nullable_unique_a ON nullable_unique (a);
  CREATE TABLE expression_unique (a text NOT NULL, b text);
  CREATE UNIQUE INDEX expression_unique_a ON expression_unique (lower(a));
  CREATE TABLE pk_wins (pk int PRIMARY KEY, x int NOT NULL, y int NOT NULL);
  CREATE UNIQUE INDEX pk_wins_x ON pk_wins (x);
  CREATE TABLE narrowest (a int NOT NULL, b int NOT NULL, c int NOT NULL);
  CREATE UNIQUE INDEX narrowest_ab ON narrowest (a, b);
  CREATE UNIQUE INDEX narrowest_c ON narrowest (c);
  CREATE TABLE with_include (a int NOT NULL, b int NOT NULL);
  CREATE UNIQUE INDEX with_include_a ON with_include (a) INCLUDE (b);

  -- masking
  CREATE TABLE accounts (id int PRIMARY KEY, email text, password_hash text, api_key text, note text);
  INSERT INTO accounts VALUES (1, 'a@x.test', '${SECRET}', 'KEY-123', 'hello'), (2, 'b@x.test', NULL, '', 'bye');
  CREATE TABLE only_secrets (password text);
  INSERT INTO only_secrets VALUES ('${SECRET}'), ('${SECRET}'), ('${SECRET}');

  -- odd shapes
  CREATE TABLE nocols ();
  CREATE TABLE wide ();
  DO $$ BEGIN
    FOR i IN 1..301 LOOP EXECUTE format('ALTER TABLE wide ADD COLUMN %I int', 'c' || i); END LOOP;
  END $$;
  INSERT INTO wide DEFAULT VALUES;
  CREATE TABLE wide_text (id int PRIMARY KEY);
  DO $$ BEGIN
    FOR i IN 1..100 LOOP EXECUTE format('ALTER TABLE wide_text ADD COLUMN %I text', 'c' || i); END LOOP;
  END $$;
  INSERT INTO wide_text (id) SELECT generate_series(1, 15);
  DO $$ BEGIN
    FOR i IN 1..100 LOOP EXECUTE format('UPDATE wide_text SET %I = repeat(''z'', 2000)', 'c' || i); END LOOP;
  END $$;

  CREATE SCHEMA "Odd Schema";
  CREATE TABLE "Odd Schema"."We""ird Table" (
    "select" int PRIMARY KEY, "Unit Price" numeric, "quo""te" text, "日本語 🙂" text, "${"a".repeat(63)}" text
  );
  INSERT INTO "Odd Schema"."We""ird Table" VALUES (1, 9.99, 'q', 'j', 'long');

  -- kinds of relation
  CREATE VIEW typed_view AS SELECT id, t FROM typed;
  CREATE MATERIALIZED VIEW typed_mv AS SELECT id, t FROM typed;
  CREATE UNIQUE INDEX typed_mv_id ON typed_mv (id);
  CREATE TABLE part (id int, d date, v text, PRIMARY KEY (id, d)) PARTITION BY RANGE (d);
  CREATE TABLE part_2026 PARTITION OF part FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
  INSERT INTO part VALUES (1, '2026-05-05', 'in partition');
  CREATE EXTENSION postgres_fdw;
  CREATE SERVER loopback FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'localhost', dbname 'none');
  CREATE FOREIGN TABLE remote_table (id int) SERVER loopback OPTIONS (table_name 'nothing');

  -- row-level security and permissions (the role is created by the test)
  CREATE TABLE secured (id int PRIMARY KEY, owner text);
  ALTER TABLE secured ENABLE ROW LEVEL SECURITY;
  CREATE TABLE private_table (id int PRIMARY KEY, secret text);
  -- owned by the test role (see beforeAll): security on, and security forced on the owner
  CREATE TABLE owned_rls (id int PRIMARY KEY);
  ALTER TABLE owned_rls ENABLE ROW LEVEL SECURITY;
  CREATE TABLE owned_forced (id int PRIMARY KEY);
  ALTER TABLE owned_forced ENABLE ROW LEVEL SECURITY;
  ALTER TABLE owned_forced FORCE ROW LEVEL SECURITY;
  INSERT INTO private_table VALUES (1, '${SECRET}');
`;

const first: RowsOptions = { pageSize: 50, cursor: null, revealColumns: [] };

describe.skipIf(!testDatabaseUrl())("PostgresAdapter.getRows", () => {
  let db: TestDatabase;
  let adapter: PostgresAdapter;
  const role = `dc_rows_${Math.random().toString(16).slice(2, 10)}`;
  const rolePassword = "role-pw-1";
  let reader: PostgresAdapter;

  const ref = (name: string, schema = "public"): TableRef => ({ schema, name });
  const read = (
    name: string,
    options: Partial<RowsOptions> = {},
    schema = "public",
  ): Promise<RowPage> => adapter.getRows(ref(name, schema), { ...first, ...options });
  const values = (page: RowPage, column: number): Array<string | null> =>
    page.rows.map((r) => r[column]!.value);

  /** Read every page of a table and return the first column of every row, in the order read. */
  async function readAll(
    name: string,
    pageSize: number,
    column = 0,
  ): Promise<Array<string | null>> {
    const seen: Array<string | null> = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 1000; guard += 1) {
      const page: RowPage = await read(name, { pageSize, cursor });
      seen.push(...values(page, column));
      cursor = page.nextCursor;
      if (cursor === null) return seen;
    }
    throw new Error("paging did not end");
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    const client = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await client.connect();
    try {
      await client.query(SQL);
      await client.query(`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD '${rolePassword}'`);
      await client.query(
        `GRANT CONNECT ON DATABASE ${quoteIdent(db.dbName)} TO ${quoteIdent(role)}`,
      );
      await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(role)}`);
      await client.query(`GRANT SELECT ON secured TO ${quoteIdent(role)}`);
      await client.query(
        `INSERT INTO secured VALUES (1, 'postgres'), (2, '${role}'), (3, '${role}')`,
      );
      await client.query(`CREATE POLICY mine ON secured USING (owner = current_user)`);
      await client.query(`ALTER TABLE owned_rls OWNER TO ${quoteIdent(role)}`);
      await client.query(`ALTER TABLE owned_forced OWNER TO ${quoteIdent(role)}`);
    } finally {
      await client.end();
    }
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
    reader = new PostgresAdapter({ ...db.connection, username: role, password: rolePassword });
    await reader.connect();
  }, 60_000);

  afterAll(async () => {
    await reader?.disconnect();
    await adapter?.disconnect();
    await db?.dispose();
    // The role is shared by the whole server, so it is removed here (its database is already gone).
    const { host, port, username, password } = db.connection;
    const admin = new pg.Client({ host, port, user: username, password, database: "postgres" });
    await admin.connect();
    try {
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
    } finally {
      await admin.end();
    }
  });

  describe("values", () => {
    it("reads every kind of type as the text PostgreSQL prints", async () => {
      const page = await read("typed");
      const row = page.rows[0]!.map((cell) => cell.value);
      expect(page.columns.map((c) => c.name)).toEqual([
        "id",
        "n",
        "f",
        "b",
        "d",
        "ts",
        "iv",
        "u",
        "j",
        "ba",
        "ip",
        "e",
        "dm",
        "arr",
        "r",
        "t",
      ]);
      expect(row).toEqual([
        "1",
        "12.50",
        "0.1",
        "true", // CAST(boolean AS text) is "true", not the "t" that psql shows
        "2026-11-16",
        "2026-11-16 10:00:00+00",
        "1 day 02:00:00",
        "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        '{"a": [1, 2]}',
        "\\xdeadbeef",
        "10.0.0.1/24",
        "ok",
        "5",
        "{1,2,3}",
        "[1,10)",
        "plain",
      ]);
    });

    it("keeps NULL (null) apart from the empty string, for every type", async () => {
      const page = await read("typed");
      const nulls = page.rows[1]!;
      expect(nulls.slice(1, 15).every((c) => c.value === null && !c.truncated)).toBe(true);
      expect(nulls[15]).toEqual({ value: "", truncated: false }); // t = ''
      // jsonb 'null' is a value, not SQL NULL.
      expect(page.rows[2]![8]!.value).toBe("null");
    });

    it("reads awkward values: infinity, negative, empty range, quotes, bytea, NaN-like extremes", async () => {
      const row = (await read("typed")).rows[2]!.map((c) => c.value);
      expect(row[1]).toBe("-0.01");
      expect(row[2]).toBe("1e+300");
      expect(row[4]).toBe("infinity");
      expect(row[5]).toBe("infinity");
      expect(row[9]).toBe("\\x");
      expect(row[14]).toBe("empty");
      expect(row[15]).toBe(`it's "quoted"`);
    });
  });

  describe("long values", () => {
    it("cuts a value in the database to the cell limit and says so", async () => {
      const page = await read("big");
      const long = page.rows[0]![1]!;
      expect(long.truncated).toBe(true);
      expect(long.value).toBe("x".repeat(ROWS_CELL_CHARS));
      expect(long.value).not.toContain("TAIL");
    });

    it("never moves a megabyte: a 1,000,000 character value comes back as 2,000", async () => {
      const cell = (await read("big")).rows[1]![1]!;
      expect(cell.value!.length).toBe(ROWS_CELL_CHARS);
      expect(cell.truncated).toBe(true);
    });

    it("does not cut an emoji in half at the limit", async () => {
      const cell = (await read("big")).rows[2]![1]!;
      expect(cell.truncated).toBe(true);
      expect(/[\ud800-\udbff]$/.test(cell.value!)).toBe(false);
      expect(/^a+$/.test(cell.value!)).toBe(true);
    });

    it("flags exactly the values over the limit: 2,000 characters fit, 2,001 do not", async () => {
      const page = await read("big");
      expect(page.rows[3]![1]).toEqual({ value: "b".repeat(2000), truncated: false });
      expect(page.rows[4]![1]).toEqual({ value: "c".repeat(2000), truncated: true });
    });

    it("pages by the REAL key when the key is longer than the cell limit", async () => {
      const page = await read("longkey", { pageSize: 2 });
      expect(page.rows[0]![0]!.truncated).toBe(true); // the shown key is cut ...
      // ... but the cursor continues after the real one: nothing repeats, nothing is skipped.
      const seen = await readAll("longkey", 2, 1);
      expect(seen).toEqual(["1", "2", "3", "4", "5"]);
      expect(await readAll("longkey", 1, 1)).toEqual(["1", "2", "3", "4", "5"]);
      expect(LONG_KEY(1).length).toBeGreaterThan(ROWS_CELL_CHARS);
    });

    it("cuts a page that would be too big, keeps the rows it has, and gives a cursor for the rest", async () => {
      // 15 rows of about 198,000 characters each (99 columns of 2,000): about 3,000,000 in all.
      const page = await read("wide_text", { pageSize: 200 });
      expect(page.cutBySize).toBe(true);
      expect(page.rows.length).toBeGreaterThan(0);
      expect(page.rows.length).toBeLessThan(15);
      const size = page.rows.flat().reduce((sum, cell) => sum + (cell.value?.length ?? 0), 0);
      expect(size).toBeLessThanOrEqual(ROWS_MAX_RESPONSE_CHARS);
      expect(page.nextCursor).not.toBeNull();
      // Reading on from the cursor loses nothing and repeats nothing.
      const all = await readAll("wide_text", 200);
      expect(all).toEqual(Array.from({ length: 15 }, (_, i) => String(i + 1)));
    });
  });

  describe("keys and paging", () => {
    it("pages a composite key without repeating or skipping a row", async () => {
      expect((await read("composite")).order).toEqual({ kind: "primary_key", columns: ["a", "b"] });
      const walk = async (size: number) => {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const page: RowPage = await read("composite", { pageSize: size, cursor });
          seen.push(...page.rows.map((r) => r[2]!.value!));
          cursor = page.nextCursor;
        } while (cursor !== null);
        return seen;
      };
      expect(await walk(1)).toEqual(["1a", "1b", "2a", "2b", "3z"]);
      expect(await walk(2)).toEqual(["1a", "1b", "2a", "2b", "3z"]);
      expect(await walk(200)).toEqual(["1a", "1b", "2a", "2b", "3z"]);
    });

    it("pages every type that can be a key (the cursor round-trips through text)", async () => {
      expect(await readAll("typed", 1)).toEqual(["1", "2", "3"]);
      expect(await readAll("accounts", 1)).toEqual(["1", "2"]);
    });

    it("uses a unique index on NOT NULL columns when there is no primary key", async () => {
      const page = await read("unique_notnull");
      expect(page.order).toEqual({ kind: "unique_index", columns: ["a"] });
      expect(values(page, 0)).toEqual(["1", "2", "3"]);
    });

    it.each(["partial_only", "nullable_unique", "expression_unique", "nokey"])(
      "does not order by an index that is not safe to order by (%s)",
      async (name) => {
        expect((await read(name)).order).toEqual({ kind: "none", columns: [] });
      },
    );

    it("prefers the primary key, then the narrowest unique index, and ignores INCLUDE columns", async () => {
      expect((await read("pk_wins")).order.columns).toEqual(["pk"]);
      expect((await read("narrowest")).order.columns).toEqual(["c"]);
      expect((await read("with_include")).order.columns).toEqual(["a"]);
    });

    it("reads a table without a key by position, down to a fixed depth", async () => {
      const seen: Array<string | null> = [];
      let cursor: string | null = null;
      let last: RowPage | null = null;
      do {
        last = await read("nokey", { pageSize: 3, cursor });
        seen.push(...values(last, 0));
        cursor = last.nextCursor;
      } while (cursor !== null);
      expect(seen.sort()).toEqual(["row1", "row2", "row3", "row4", "row5", "row6", "row7"]);
      expect(last.order.kind).toBe("none");
    });

    it("stops at the maximum depth of an unordered table and says so", async () => {
      const deep = encodeRowsCursor({ kind: "offset", offset: ROWS_MAX_OFFSET });
      const page = await read("nokey", { cursor: deep });
      expect(page.rows).toEqual([]);
      expect(page.nextCursor).toBeNull();
      expect(page.offsetCapped).toBe(false); // nothing beyond it in this small table
    });

    it("refuses a cursor from the other kind of table", async () => {
      await expect(
        read("nokey", { cursor: encodeRowsCursor({ kind: "keyset", values: ["1"] }) }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        read("typed", { cursor: encodeRowsCursor({ kind: "offset", offset: 1 }) }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    });

    it("a forged key can only move where the page starts", async () => {
      const page = await read("typed", {
        cursor: encodeRowsCursor({ kind: "keyset", values: ["2"] }),
      });
      expect(values(page, 0)).toEqual(["3"]);
      const none = await read("typed", {
        cursor: encodeRowsCursor({ kind: "keyset", values: ["99999"] }),
      });
      expect(none.rows).toEqual([]);
    });
  });

  describe("masking", () => {
    it("does not read a column whose name looks sensitive, and the value never leaves the database", async () => {
      const page = await read("accounts");
      expect(page.columns.map((c) => [c.name, c.masked])).toEqual([
        ["id", false],
        ["email", false],
        ["password_hash", true],
        ["api_key", true],
        ["note", false],
      ]);
      expect(page.rows[0]!.map((c) => c.value)).toEqual(["1", "a@x.test", null, null, "hello"]);
      expect(JSON.stringify(page)).not.toContain(SECRET);
      expect(JSON.stringify(page)).not.toContain("KEY-123");
    });

    it("reveals only the columns that are asked for by name", async () => {
      const page = await read("accounts", { revealColumns: ["api_key", "no_such_column"] });
      expect(page.rows[0]!.map((c) => c.value)).toEqual([
        "1",
        "a@x.test",
        null,
        "KEY-123",
        "hello",
      ]);
      expect(page.columns.find((c) => c.name === "password_hash")!.masked).toBe(true);
      expect(JSON.stringify(page)).not.toContain(SECRET);
      expect(
        (await read("accounts", { revealColumns: ["password_hash"] })).rows[0]![2]!.value,
      ).toBe(SECRET);
    });

    it("still returns the rows of a table whose every column is masked", async () => {
      const page = await read("only_secrets");
      expect(page.rows).toHaveLength(3);
      expect(page.rows.flat().every((c) => c.value === null)).toBe(true);
      expect(JSON.stringify(page)).not.toContain(SECRET);
    });
  });

  describe("shapes of table", () => {
    it("gives an empty page for a table with no columns", async () => {
      expect(await read("nocols")).toMatchObject({ columns: [], rows: [], nextCursor: null });
    });

    it("reads the first 100 columns of a wide table and says how many were left out", async () => {
      const page = await read("wide");
      expect(page.columns).toHaveLength(ROWS_MAX_COLUMNS);
      expect(page.hiddenColumns).toBe(201);
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toHaveLength(ROWS_MAX_COLUMNS);
    });

    it("reads names that need quoting, in another schema, with a 63-byte column", async () => {
      const page = await read('We"ird Table', {}, "Odd Schema");
      expect(page.columns.map((c) => c.name)).toEqual([
        "select",
        "Unit Price",
        'quo"te',
        "日本語 🙂",
        "a".repeat(63),
      ]);
      expect(page.rows[0]!.map((c) => c.value)).toEqual(["1", "9.99", "q", "j", "long"]);
      expect(page.order).toEqual({ kind: "primary_key", columns: ["select"] });
    });

    it("reads a view, a materialized view and a partitioned table", async () => {
      const view = await read("typed_view");
      expect(view.order.kind).toBe("none");
      expect(view.rows).toHaveLength(3);
      // A materialized view's columns are never NOT NULL, so even a unique index on one
      // is not safe to page by (a NULL key would break "after the last key"): no order.
      const matview = await read("typed_mv");
      expect(matview.order).toEqual({ kind: "none", columns: [] });
      expect(matview.rows).toHaveLength(3);
      const part = await read("part");
      expect(part.order.columns).toEqual(["id", "d"]);
      expect(part.rows[0]!.map((c) => c.value)).toEqual(["1", "2026-05-05", "in partition"]);
    });

    it("refuses a foreign table (not_supported) before touching it", async () => {
      await expect(read("remote_table")).rejects.toMatchObject({ code: "not_supported" });
    });
  });

  describe("permissions and row-level security", () => {
    it("a role without SELECT gets permission_denied, a fixed message, and no value", async () => {
      expect.assertions(4);
      try {
        await reader.getRows(ref("private_table"), first);
      } catch (error) {
        expect(error).toMatchObject({ name: "DatabaseError", code: "permission_denied" });
        expect(JSON.stringify(error)).not.toContain(SECRET);
        expect(String((error as Error).message)).toBe(
          "The database user does not have permission to read this information.",
        );
        expect(String((error as { cause?: unknown }).cause)).not.toContain(SECRET);
      }
    });

    it("shows only the rows row-level security allows, without any sign of the others", async () => {
      const page = await reader.getRows(ref("secured"), first);
      expect(values(page, 0)).toEqual(["2", "3"]);
      expect(values(page, 1)).toEqual([role, role]);
      // The owner (a superuser here) bypasses the policy and sees everything.
      expect(values(await read("secured"), 0)).toEqual(["1", "2", "3"]);
    });

    it("says whether row-level security applies to the connected role", async () => {
      // Not switched on.
      expect((await read("private_table")).rowSecurity).toBe("off");
      // On, and this role is subject to it; the superuser is not.
      expect((await reader.getRows(ref("secured"), first)).rowSecurity).toBe("applies");
      expect((await read("secured")).rowSecurity).toBe("exempt");
      // The owner is exempt unless the table forces security on its owner too.
      expect((await reader.getRows(ref("owned_rls"), first)).rowSecurity).toBe("exempt");
      expect((await reader.getRows(ref("owned_forced"), first)).rowSecurity).toBe("applies");
    });
  });

  describe("errors never repeat a value", () => {
    it("a forged key that is not valid for its type gives a fixed message, not PostgreSQL's", async () => {
      const forged = "not-a-number-FORGED-SECRET";
      expect.assertions(4);
      try {
        await read("typed", { cursor: encodeRowsCursor({ kind: "keyset", values: [forged] }) });
      } catch (error) {
        expect(error).toMatchObject({ name: "DatabaseError", code: "invalid_request" });
        expect(String((error as Error).message)).not.toContain(forged);
        expect(JSON.stringify(error)).not.toContain(forged);
        expect(String((error as Error).message)).toBe(
          "The request could not be used. The page size or the paging position is not valid for this table.",
        );
      }
    });

    it("a key value that PostgreSQL rejects as out of range is also a fixed message", async () => {
      const huge = "9".repeat(400);
      await expect(
        read("typed", { cursor: encodeRowsCursor({ kind: "keyset", values: [huge] }) }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    });
  });

  it("is deterministic: the same page twice is the same", async () => {
    expect(await read("composite", { pageSize: 2 })).toEqual(
      await read("composite", { pageSize: 2 }),
    );
  });
});
