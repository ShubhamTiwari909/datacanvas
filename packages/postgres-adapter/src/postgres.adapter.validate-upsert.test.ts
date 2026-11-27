/**
 * `validateRows()` with `upsertKey` against a real PostgreSQL (`docs/write-side-v2-plan.md`, section 4.1 and
 * 13.1 items 4 and 8): an import that will be an UPSERT keyed by a primary key or unique constraint.
 *  - A row matching an existing row by the chosen key is an update, not `unique_existing`.
 *  - Another unique key fails only on an existing row OTHER than the one the file row would update.
 *  - Repeated keys in the file are still `unique_in_request` (the apply would fail with 21000).
 *  - The key must be exactly a non-deferrable primary key or unique constraint with NOT NULL columns, all given.
 *  - The report never holds a value; without `upsertKey` nothing changes.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set. Runs in its own throwaway database.
 */
import {
  DatabaseError,
  VALIDATE_ROWS_LISTED,
  type ValidateRequest,
  type ValidationReport,
} from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const SECRET = "hunter2-SECRET-VALUE";
const BULK = 1200;

const SQL = `
  CREATE TABLE tag_parent (tag text PRIMARY KEY);
  INSERT INTO tag_parent VALUES ('ok');
  CREATE TABLE item (
    id int PRIMARY KEY,
    code text NOT NULL CONSTRAINT item_code_key UNIQUE,
    email text CONSTRAINT item_email_key UNIQUE,
    qty int CONSTRAINT item_qty_ok CHECK (qty >= 0),
    tag text CONSTRAINT item_tag_fkey REFERENCES tag_parent (tag)
  );
  INSERT INTO item VALUES (1, 'A', 'a@x.test', 1, 'ok'), (2, 'B', 'b@x.test', 1, 'ok'), (3, 'C', NULL, 1, NULL);

  CREATE TABLE pair (a int, b int, label text CONSTRAINT pair_label_key UNIQUE, PRIMARY KEY (a, b));
  INSERT INTO pair VALUES (1, 1, 'x'), (1, 2, 'y');

  -- keys an upsert may not use
  CREATE TABLE odd (
    id int PRIMARY KEY,
    late int NOT NULL CONSTRAINT odd_late_key UNIQUE DEFERRABLE INITIALLY IMMEDIATE,
    tag text NOT NULL,
    idx int NOT NULL,
    plain int NOT NULL
  );
  CREATE UNIQUE INDEX odd_tag_partial ON odd (tag) WHERE tag <> 'x';
  CREATE UNIQUE INDEX odd_idx_only ON odd (idx);
  CREATE UNIQUE INDEX odd_lower_tag ON odd (lower(tag));

  CREATE TABLE bulk (id int PRIMARY KEY, code text NOT NULL CONSTRAINT bulk_code_key UNIQUE);
  INSERT INTO bulk SELECT g, 'c' || g FROM generate_series(1, ${BULK}) AS g;

  CREATE TABLE "we""ird tbl" (
    "k""ey; drop" text NOT NULL CONSTRAINT "we""ird pk" PRIMARY KEY,
    "Ötz ""u" text NOT NULL CONSTRAINT "we""ird u" UNIQUE
  );
  INSERT INTO "we""ird tbl" VALUES ('k1', 'u1'), ('k2', 'u2');

  CREATE TABLE marked (
    k text PRIMARY KEY,
    code text NOT NULL CONSTRAINT marked_code_key UNIQUE,
    note text CONSTRAINT marked_note_short CHECK (length(note) < 40)
  );
  INSERT INTO marked VALUES ('${SECRET}-k1', '${SECRET}-c1', NULL), ('${SECRET}-k2', '${SECRET}-c2', NULL);

  CREATE TABLE vault (api_token text PRIMARY KEY, code text NOT NULL CONSTRAINT vault_code_key UNIQUE);
  INSERT INTO vault VALUES ('t1', 'v1'), ('t2', 'v2');
`;

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

interface Brief {
  rule: string;
  constraint: string | null;
  rows: number[];
}
/** Issues in a fixed order (by rule, then constraint), for a comparison that does not depend on the report's order. */
const sorted = (issues: Brief[]) =>
  [...issues].sort(
    (a, b) =>
      a.rule.localeCompare(b.rule) || (a.constraint ?? "").localeCompare(b.constraint ?? ""),
  );
/** The issues as rule, constraint and rows. */
const brief = (report: ValidationReport) =>
  sorted(report.issues.map((i) => ({ rule: i.rule, constraint: i.constraint, rows: i.rows })));

describe.skipIf(!testDatabaseUrl())("PostgreSQL validateRows with upsertKey", () => {
  let db: TestDatabase;
  let client: pg.Client;
  let adapter: PostgresAdapter;
  const t = (name: string) => ({ schema: "public", name });

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

  const insert = (
    table: string,
    columns: string[],
    rows: Array<Array<string | null>>,
    extra: Partial<ValidateRequest> = {},
  ): ValidateRequest => ({ table: t(table), mode: "insert", columns, rows, ...extra });

  const refusal = async (request: ValidateRequest) => {
    const error = await adapter.validateRows(request).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DatabaseError);
    return (error as DatabaseError).code;
  };

  const ITEM = ["id", "code", "email", "qty", "tag"];
  /** Rows of `item` and what each one does when keyed by `id`. */
  const itemRows: Array<Array<string | null>> = [
    ["1", "A", "a@x.test", "5", "ok"], // 1: matches row 1 by id, collides with itself on code and email: fine
    ["2", "A", null, "5", "ok"], // 2: updates row 2, but code A is row 1's: unique_existing on code
    ["9", "B", null, "5", "ok"], // 3: new, code B is row 2's: unique_existing on code
    ["1", "Z", "b@x.test", "5", "ok"], // 4: updates row 1, email is row 2's: unique_existing on email
    ["3", "C", null, "5", "ok"], // 5: matches row 3 by id, same code: fine
    ["10", "N", "n@x.test", "5", "ok"], // 6: new, nothing taken: fine
  ];

  it("keyed by the primary key: a match is an update, a collision with the very row it updates is fine", async () => {
    const report = await adapter.validateRows(
      insert("item", ITEM, itemRows, { upsertKey: ["id"] }),
    );
    expect(brief(report)).toEqual(
      sorted([
        // Rows 1 and 4 have the same id, rows 1 and 2 the same code: the apply would fail.
        { rule: "unique_in_request", constraint: "item_pkey", rows: [1, 4] },
        { rule: "unique_in_request", constraint: "item_code_key", rows: [1, 2] },
        { rule: "unique_existing", constraint: "item_code_key", rows: [2, 3] },
        { rule: "unique_existing", constraint: "item_email_key", rows: [4] },
      ]),
    );
    // No unique_existing on the chosen key: rows 1, 2, 4 and 5 match existing rows by id.
    expect(
      report.issues.some((i) => i.constraint === "item_pkey" && i.rule === "unique_existing"),
    ).toBe(false);
    expect(report.passed).toBe(6 - 4);
  });

  it("without upsertKey, the same file is judged as an insert, as before", async () => {
    const report = await adapter.validateRows(insert("item", ITEM, itemRows));
    expect(brief(report)).toEqual(
      sorted([
        { rule: "unique_existing", constraint: "item_code_key", rows: [1, 2, 3, 5] },
        { rule: "unique_existing", constraint: "item_email_key", rows: [1, 4] },
        { rule: "unique_existing", constraint: "item_pkey", rows: [1, 2, 4, 5] },
        { rule: "unique_in_request", constraint: "item_pkey", rows: [1, 4] },
        { rule: "unique_in_request", constraint: "item_code_key", rows: [1, 2] },
      ]),
    );
  });

  it("flags repeated keys of the file, even when they match an existing row", async () => {
    const report = await adapter.validateRows(
      insert(
        "item",
        ["id", "code"],
        [
          ["1", "A"],
          ["7", "P"],
          ["1", "A"],
          ["7", "Q"],
          ["8", "R"],
        ],
        { upsertKey: ["id"] },
      ),
    );
    expect(brief(report)).toEqual(
      sorted([
        { rule: "unique_in_request", constraint: "item_pkey", rows: [1, 2, 3, 4] },
        // Code A twice in the file is also a repeat; against the table it is row 1's own code: no unique_existing.
        { rule: "unique_in_request", constraint: "item_code_key", rows: [1, 3] },
      ]),
    );
  });

  it("keyed by a unique constraint: another key colliding with a different row is unique_existing", async () => {
    const report = await adapter.validateRows(
      insert(
        "item",
        ["id", "code"],
        [
          ["2", "B"], // 1: matches row 2 by code, same id: fine
          ["1", "C"], // 2: updates row 3 (code C), id 1 is row 1's: unique_existing on the primary key
          ["50", "A"], // 3: updates row 1, new id: fine
          ["60", "NEW"], // 4: new: fine
        ],
        { upsertKey: ["code"] },
      ),
    );
    expect(brief(report)).toEqual([
      { rule: "unique_existing", constraint: "item_pkey", rows: [2] },
    ]);
  });

  it("takes a composite key in any order", async () => {
    const rows = [
      ["1", "1", "x"], // 1: matches (1, 1), its own label: fine
      ["1", "1", "y"], // 2: updates (1, 1), label y is (1, 2)'s: unique_existing
      ["2", "2", "x"], // 3: new, label x is (1, 1)'s: unique_existing
      ["1", "2", "y"], // 4: matches (1, 2), its own label: fine
      ["3", "3", "z"], // 5: new: fine
    ];
    for (const upsertKey of [
      ["a", "b"],
      ["b", "a"],
    ]) {
      const report = await adapter.validateRows(
        insert("pair", ["a", "b", "label"], rows, { upsertKey }),
      );
      expect(brief(report)).toEqual(
        sorted([
          // Rows 1 and 2 have the same key; labels x and y each appear twice in the file.
          { rule: "unique_in_request", constraint: "pair_pkey", rows: [1, 2] },
          { rule: "unique_in_request", constraint: "pair_label_key", rows: [1, 2, 3, 4] },
          { rule: "unique_existing", constraint: "pair_label_key", rows: [2, 3] },
        ]),
      );
    }
  });

  it.each([
    ["part of a composite key", "pair", ["a", "b", "label"], ["a"]],
    ["more than a key", "item", ["id", "code"], ["id", "code"]],
    ["a unique column that may be NULL", "item", ["id", "email"], ["email"]],
    ["a column that is not unique", "item", ["id", "qty"], ["qty"]],
    ["a column that does not exist", "item", ["id"], ["nope"]],
    ["a key column the file does not give", "item", ["code"], ["id"]],
    ["a deferrable unique constraint", "odd", ["id", "late"], ["late"]],
    ["a partial unique index", "odd", ["id", "tag"], ["tag"]],
    ["a unique index that is not a constraint", "odd", ["id", "idx"], ["idx"]],
    ["a not-null column that is not a key", "odd", ["id", "plain"], ["plain"]],
  ])("refuses %s as the key, with invalid_request", async (_name, table, columns, upsertKey) => {
    const rows = [columns.map(() => "1")];
    expect(await refusal(insert(table, columns, rows, { upsertKey }))).toBe("invalid_request");
  });

  it("refuses upsertKey with an update", async () => {
    expect(
      await refusal({
        table: t("item"),
        mode: "update",
        columns: ["code"],
        rows: [["Q"]],
        key: [{ column: "id", value: "1" }],
        upsertKey: ["id"],
      }),
    ).toBe("invalid_request");
  });

  it("quotes hostile identifiers in every statement", async () => {
    const report = await adapter.validateRows(
      insert(
        'we"ird tbl',
        ['k"ey; drop', 'Ötz "u'],
        [
          ["k1", "u1"], // matches k1, its own value: fine
          ["k1", "u2"], // updates k1, u2 is k2's: unique_existing
          ["k3", "u3"], // new: fine
          ["k3", "u4"], // the key twice in the file
        ],
        { upsertKey: ['k"ey; drop'] },
      ),
    );
    expect(brief(report)).toEqual(
      sorted([
        { rule: "unique_in_request", constraint: 'we"ird pk', rows: [1, 2, 3, 4] },
        { rule: "unique_existing", constraint: 'we"ird u', rows: [2] },
      ]),
    );
    // The table is untouched.
    const { rows } = await client.query('SELECT count(*)::int AS n FROM "we""ird tbl"');
    expect(rows[0].n).toBe(2);
  });

  it("composes with listAll: every failing row is listed, past the usual twenty", async () => {
    // Rows 1-200 match existing rows by id with their own code; 201-260 are new with a code another row holds;
    // 261-300 repeat the ids of rows 1-40 with new codes.
    const rows: string[][] = [
      ...range(1, 200).map((n) => [String(n), `c${n}`]),
      ...range(201, 260).map((n) => [String(5000 + n), `c${n - 200}`]),
      ...range(261, 300).map((n) => [String(n - 260), `z${n}`]),
    ];
    const all = await adapter.validateRows(
      insert("bulk", ["id", "code"], rows, { upsertKey: ["id"], listAll: true }),
    );
    expect(all.notChecked).not.toContain("stopped_early");
    expect(all.issues.find((i) => i.rule === "unique_existing")).toEqual({
      rule: "unique_existing",
      column: null,
      constraint: "bulk_code_key",
      count: 60,
      rows: range(201, 260),
    });
    // The codes of 201-260 repeat those of rows 1-60 of the file as well.
    expect(
      all.issues.find((i) => i.constraint === "bulk_code_key" && i.rule === "unique_in_request"),
    ).toMatchObject({ count: 120, rows: [...range(1, 60), ...range(201, 260)] });
    expect(all.issues.find((i) => i.constraint === "bulk_pkey")).toEqual({
      rule: "unique_in_request",
      column: null,
      constraint: "bulk_pkey",
      count: 80,
      rows: [...range(1, 40), ...range(261, 300)],
    });
    // Failing: 1-60 and 201-260 (codes), 261-300 (ids; 1-40 already counted).
    expect(all.passed).toBe(300 - 60 - 60 - 40);

    const usual = await adapter.validateRows(
      insert("bulk", ["id", "code"], rows, { upsertKey: ["id"] }),
    );
    const existing = usual.issues.find((i) => i.rule === "unique_existing")!;
    expect(existing.count).toBe(60);
    expect(existing.rows).toEqual(range(201, 200 + VALIDATE_ROWS_LISTED));
  });

  it("checks the key of the file but judges no other key against the table when the upsert key looks sensitive", async () => {
    const report = await adapter.validateRows(
      insert(
        "vault",
        ["api_token", "code"],
        [
          ["t1", "v2"], // would collide with t2's code: not judged
          ["t1", "v9"], // the key twice in the file
        ],
        { upsertKey: ["api_token"] },
      ),
    );
    expect(brief(report)).toEqual([
      { rule: "unique_in_request", constraint: "vault_pkey", rows: [1, 2] },
    ]);
    expect(report.notChecked).toContain("hidden_columns");
  });

  it("never puts a value in the report", async () => {
    const report = await adapter.validateRows(
      insert(
        "marked",
        ["k", "code", "note"],
        [
          [`${SECRET}-k1`, `${SECRET}-c1`, SECRET], // 1: matches k1 with its own code: fine
          [`${SECRET}-k1`, `${SECRET}-c2`, SECRET], // 2: repeats k1; c2 is k2's
          [`${SECRET}-k3`, `${SECRET}-c1`, SECRET], // 3: new; c1 is k1's (and row 1's)
          [`${SECRET}-k4`, `${SECRET}-c9`, `${SECRET}-${"x".repeat(40)}`], // 4: note too long
          [`${SECRET}-k5`, null, SECRET], // 5: code may not be NULL
        ],
        { upsertKey: ["k"], listAll: true },
      ),
    );
    expect(brief(report)).toEqual(
      sorted([
        { rule: "unique_in_request", constraint: "marked_pkey", rows: [1, 2] },
        { rule: "unique_in_request", constraint: "marked_code_key", rows: [1, 3] },
        { rule: "unique_existing", constraint: "marked_code_key", rows: [2, 3] },
        { rule: "check", constraint: "marked_note_short", rows: [4] },
        { rule: "not_null", constraint: null, rows: [5] },
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("hunter2");
  });
});
