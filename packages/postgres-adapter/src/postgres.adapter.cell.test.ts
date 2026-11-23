/**
 * `getCell()` against a real PostgreSQL: one `json` or `jsonb` value read whole for the JSON editor.
 * The key names the row, the column must be JSON, a hidden column needs revealing, a value over 1 MB
 * is measured in the database and never sent, and no error ever repeats a value.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set. Runs in its own throwaway database.
 */
import { CELL_EDIT_MAX_CHARS, type CellRequest } from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const SECRET = "hunter2-SECRET-VALUE";

const SQL = `
  CREATE TABLE docs (id int PRIMARY KEY, body jsonb, raw json, label text);
  INSERT INTO docs VALUES
    (1, '{"a": [1, 2], "big": 12345678901234567890}', '{"b":   1}', 'one'),
    (2, NULL, NULL, 'two'),
    (3, jsonb_build_object('text', repeat('x', 3000)), NULL, 'three');
  INSERT INTO docs VALUES (4, jsonb_build_object('text', repeat('y', 1000000)), NULL, 'huge');

  CREATE TABLE composite (a int, b text, doc jsonb, PRIMARY KEY (a, b));
  INSERT INTO composite VALUES (1, 'x', '{"k": 1}'), (1, 'y', '{"k": 2}'), (2, 'x', '{"k": 3}');

  CREATE TABLE nokey (doc jsonb);
  INSERT INTO nokey VALUES ('{"a": 1}');

  CREATE TABLE secrets (id int PRIMARY KEY, secret_doc jsonb);
  INSERT INTO secrets VALUES (1, '{"token": "${SECRET}"}');

  CREATE TABLE dupes (id int PRIMARY KEY, doc jsonb);
  INSERT INTO dupes VALUES (1, '{}');

  CREATE TABLE sessions (token text PRIMARY KEY, data jsonb);
  INSERT INTO sessions VALUES ('guess-me', '{"a": 1}');
  CREATE VIEW docs_view AS SELECT id, body FROM docs;
  CREATE MATERIALIZED VIEW docs_mv AS SELECT id, body FROM docs;
  CREATE UNIQUE INDEX docs_mv_id ON docs_mv (id);
`;

const docs = { schema: "public", name: "docs" };
const ask = (over: Partial<CellRequest> = {}): CellRequest => ({
  column: "body",
  key: [{ column: "id", value: "1" }],
  revealColumns: [],
  ...over,
});

describe.skipIf(!testDatabaseUrl())("PostgreSQL getCell", () => {
  let db: TestDatabase;
  let client: pg.Client;
  let adapter: PostgresAdapter;

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

  const code = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      return (error as { code?: string }).code ?? "(no code)";
    }
    return "(no error)";
  };

  it("reads a jsonb value as the database prints it, with its digits intact", async () => {
    const cell = await adapter.getCell(docs, ask());
    expect(cell).toEqual({ value: '{"a": [1, 2], "big": 12345678901234567890}', tooLarge: false });
  });

  it("reads a json value as the text that was stored, white space and all", async () => {
    const cell = await adapter.getCell(docs, ask({ column: "raw" }));
    expect(cell).toEqual({ value: '{"b":   1}', tooLarge: false });
  });

  it("keeps SQL NULL as null, not as an empty string, and not as too large", async () => {
    expect(await adapter.getCell(docs, ask({ key: [{ column: "id", value: "2" }] }))).toEqual({
      value: null,
      tooLarge: false,
    });
  });

  it("reads a value far longer than a cell of a page (2,000 characters) whole", async () => {
    const cell = await adapter.getCell(docs, ask({ key: [{ column: "id", value: "3" }] }));
    expect(cell.tooLarge).toBe(false);
    expect(cell.value!.length).toBeGreaterThan(3000);
    expect(JSON.parse(cell.value!).text).toHaveLength(3000);
  });

  it("does not send a value over the limit, and says so", async () => {
    const cell = await adapter.getCell(docs, ask({ key: [{ column: "id", value: "4" }] }));
    expect(cell).toEqual({ value: null, tooLarge: true });
    expect(CELL_EDIT_MAX_CHARS).toBe(1_000_000);
  });

  it("finds a row by a composite key, in any order of the key's columns", async () => {
    const composite = { schema: "public", name: "composite" };
    const request = (key: CellRequest["key"]): CellRequest => ({
      column: "doc",
      key,
      revealColumns: [],
    });
    const a = await adapter.getCell(
      composite,
      request([
        { column: "a", value: "1" },
        { column: "b", value: "y" },
      ]),
    );
    expect(a.value).toBe('{"k": 2}');
    const b = await adapter.getCell(
      composite,
      request([
        { column: "b", value: "x" },
        { column: "a", value: "2" },
      ]),
    );
    expect(b.value).toBe('{"k": 3}');
  });

  it("refuses anything but the table's whole key, once per column", async () => {
    const composite = { schema: "public", name: "composite" };
    const doc = (key: CellRequest["key"]): CellRequest => ({
      column: "doc",
      key,
      revealColumns: [],
    });
    // Only part of the key: it could match several rows.
    expect(await code(adapter.getCell(composite, doc([{ column: "a", value: "1" }])))).toBe(
      "invalid_request",
    );
    // A column that is not the key: it would be a way to search by a value.
    expect(
      await code(adapter.getCell(docs, ask({ key: [{ column: "label", value: "one" }] }))),
    ).toBe("invalid_request");
    // The same key column twice.
    expect(
      await code(
        adapter.getCell(
          composite,
          doc([
            { column: "a", value: "1" },
            { column: "a", value: "1" },
          ]),
        ),
      ),
    ).toBe("invalid_request");
    // A key column that does not exist.
    expect(await code(adapter.getCell(docs, ask({ key: [{ column: "nope", value: "1" }] })))).toBe(
      "invalid_request",
    );
    // No key at all.
    expect(await code(adapter.getCell(docs, ask({ key: [] })))).toBe("invalid_request");
  });

  it("refuses a table without a key, a column that is not JSON, and a column that does not exist", async () => {
    expect(
      await code(
        adapter.getCell(
          { schema: "public", name: "nokey" },
          { column: "doc", key: [], revealColumns: [] },
        ),
      ),
    ).toBe("invalid_request");
    expect(await code(adapter.getCell(docs, ask({ column: "label" })))).toBe("invalid_request");
    expect(await code(adapter.getCell(docs, ask({ column: "id" })))).toBe("invalid_request");
    expect(await code(adapter.getCell(docs, ask({ column: "missing" })))).toBe("invalid_request");
  });

  it("says not_found for a row or a table that is not there", async () => {
    expect(await code(adapter.getCell(docs, ask({ key: [{ column: "id", value: "99" }] })))).toBe(
      "not_found",
    );
    expect(await code(adapter.getCell({ schema: "public", name: "missing" }, ask()))).toBe(
      "not_found",
    );
  });

  it("keeps a hidden column hidden unless it was revealed", async () => {
    const secrets = { schema: "public", name: "secrets" };
    const request: CellRequest = {
      column: "secret_doc",
      key: [{ column: "id", value: "1" }],
      revealColumns: [],
    };
    expect(await code(adapter.getCell(secrets, request))).toBe("invalid_request");
    const revealed = await adapter.getCell(secrets, { ...request, revealColumns: ["secret_doc"] });
    expect(revealed.value).toContain(SECRET);
  });

  it("answers a key value of the wrong type with a fixed code, and no error repeats a value", async () => {
    const attempts = [
      ask({ key: [{ column: "id", value: `not-a-number-${SECRET}` }] }),
      ask({ key: [{ column: "id", value: "99999999999999999999" }] }),
      ask({ column: SECRET }),
    ];
    for (const attempt of attempts) {
      const failure = await adapter.getCell(docs, attempt).then(
        () => null,
        (error: unknown) => error as Error & { code?: string },
      );
      expect(failure).not.toBeNull();
      expect(failure!.code).toBe("invalid_request");
      const message = String(failure!.message);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain("99999999999999999999");
    }
  });

  it("treats a hostile key value as a value: quotes and SQL in it match nothing", async () => {
    const hostile = "1'; DROP TABLE docs; --";
    expect(
      await code(adapter.getCell(docs, ask({ key: [{ column: "id", value: hostile }] }))),
    ).toBe("invalid_request");
    const still = await client.query("SELECT count(*)::int AS n FROM docs");
    expect(still.rows[0].n).toBe(4);
  });

  it("refuses a view and a materialized view: neither has a key the rows can be found by", async () => {
    // A materialized view's columns can be NULL, so a unique index on it is not a safe key (as for a page).
    for (const name of ["docs_view", "docs_mv"]) {
      expect(
        await code(
          adapter.getCell(
            { schema: "public", name },
            { column: "body", key: [{ column: "id", value: "1" }], revealColumns: [] },
          ),
        ),
      ).toBe("invalid_request");
    }
  });

  it("leaves the data as it was: a read only", async () => {
    await adapter.getCell(docs, ask());
    const { rows } = await client.query("SELECT count(*)::int AS n FROM docs");
    expect(rows[0].n).toBe(4);
  });

  it("refuses a hidden key column: a right guess and a wrong one must not answer differently", async () => {
    const sessions = { schema: "public", name: "sessions" };
    const ask = (value: string, revealColumns: string[] = []): CellRequest => ({
      column: "data",
      key: [{ column: "token", value }],
      revealColumns,
    });
    expect(await code(adapter.getCell(sessions, ask("guess-me")))).toBe("invalid_request");
    expect(await code(adapter.getCell(sessions, ask("wrong-guess")))).toBe("invalid_request");
    // Revealed on purpose (the person showed the column), it works as for a page.
    const shown = await adapter.getCell(sessions, ask("guess-me", ["token"]));
    expect(shown.value).toContain('"a"');
  });
});
