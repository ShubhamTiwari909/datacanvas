/**
 * Spike E0 of the write side, second part (`docs/write-side-v2-plan.md`, sections 4.1, 4.2, 6 and 13): the facts the
 * new statement shapes stand on, kept as tests so a PostgreSQL version that changes one is noticed. Nothing here is
 * production code: the statements are written out by hand in the shape the plan describes.
 *
 *   1. The import batch of 1.9.0 with a conflict clause, `INSERT ... SELECT CAST(...) FROM unnest(arrays)
 *      ON CONFLICT (cols)`, infers its arbiter from a primary key or a full unique constraint, single or composite,
 *      in any column order. A partial unique index is not inferred without its predicate, an expression index not
 *      from a column list, and a DEFERRABLE constraint is refused as an arbiter (55000).
 *   2. NULL never conflicts in a nullable unique column (NULLS NOT DISTINCT, PostgreSQL 15 and later, changes that),
 *      and a conflict on a unique constraint that is NOT the arbiter is an error (23505), not an update.
 *   3. `RETURNING (xmax = 0)` tells an inserted row from an updated one. rowCount is every row with DO UPDATE and
 *      only the new rows with DO NOTHING; wrapped in a CTE that counts, rowCount is 1. It needs SELECT on the TABLE.
 *   4. Two rows of one batch with the same key: DO UPDATE fails (21000); DO NOTHING keeps the first, one row short.
 *   5. `UPDATE ... FROM unnest(...)` and `DELETE ... USING unnest(...)`: rowCount is the number of target rows touched:
 *      a key that matches nothing makes it short, and a key carried twice counts once.
 *
 * The timings of the same statements on 100,000 rows are opt-in (DC_SPIKE=1), like the export spike.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

let db: TestDatabase;
let client: pg.Client;
/** `server_version_num`, e.g. 170012. */
let serverVersion = 0;

beforeAll(async () => {
  if (!testDatabaseUrl()) return;
  db = await createTestDatabase();
  const { host, port, username, password } = db.connection;
  client = new pg.Client({ host, port, user: username, password, database: db.dbName });
  await client.connect();
  serverVersion = Number(
    (await client.query("SELECT current_setting('server_version_num') AS v")).rows[0]!.v,
  );
}, 120_000);
afterAll(async () => {
  await client?.end().catch(() => {});
  await db?.dispose().catch(() => {});
});

const q = (text: string, values: unknown[] = []) => client.query(text, values);

/** Run `work` in a transaction that is always rolled back, so every test starts from the same rows. */
async function rolledBack<T>(work: () => Promise<T>): Promise<T> {
  await q("BEGIN");
  try {
    return await work();
  } finally {
    await q("ROLLBACK");
  }
}

/** The SQLSTATE of a statement, or "ok" when it ran (inside a savepoint, so the transaction goes on). */
async function outcome(text: string, values: unknown[] = []): Promise<string> {
  await q("SAVEPOINT s");
  try {
    await q(text, values);
    await q("RELEASE SAVEPOINT s");
    return "ok";
  } catch (error) {
    await q("ROLLBACK TO SAVEPOINT s");
    return (error as pg.DatabaseError).code ?? "?";
  }
}

type Column = readonly [name: string, castType: string];

/**
 * The import batch of 1.9.0 (`buildInsertBatch`) with a clause after it:
 *
 *   INSERT INTO t ("a", "b") SELECT CAST(x.c0 AS integer), CAST(x.c1 AS text)
 *   FROM unnest($1::text[], $2::text[]) AS x(c0, c1) <tail>
 */
function insertBatch(table: string, columns: readonly Column[], tail: string): string {
  const names = columns.map(([name]) => `"${name}"`).join(", ");
  const casts = columns.map(([, type], i) => `CAST(x.c${i} AS ${type})`).join(", ");
  const arrays = columns.map((_, i) => `$${i + 1}::text[]`).join(", ");
  const aliases = columns.map((_, i) => `c${i}`).join(", ");
  return `INSERT INTO ${table} (${names}) SELECT ${casts} FROM unnest(${arrays}) AS x(${aliases}) ${tail}`;
}

/** Rows (as the browser holds them) to one bound array of text per column, as the batch takes them. */
const columnsOf = (
  rows: ReadonlyArray<ReadonlyArray<string | null>>,
): Array<Array<string | null>> => rows[0]!.map((_, i) => rows.map((r) => r[i] ?? null));

/**
 * The keyed update of `update_by_key` (section 4.2) and of a bulk change (section 6):
 *
 *   UPDATE t AS t SET "v" = CAST(x.c1 AS text)
 *   FROM unnest($1::text[], $2::text[]) AS x(c0, c1) WHERE t."k" = CAST(x.c0 AS integer)
 */
function keyedUpdate(table: string, key: readonly Column[], set: readonly Column[]): string {
  const all = [...key, ...set];
  const arrays = all.map((_, i) => `$${i + 1}::text[]`).join(", ");
  const aliases = all.map((_, i) => `c${i}`).join(", ");
  const sets = set
    .map(([name, type], i) => `"${name}" = CAST(x.c${key.length + i} AS ${type})`)
    .join(", ");
  const where = key
    .map(([name, type], i) => `t."${name}" = CAST(x.c${i} AS ${type})`)
    .join(" AND ");
  return `UPDATE ${table} AS t SET ${sets} FROM unnest(${arrays}) AS x(${aliases}) WHERE ${where}`;
}

/** The keyed delete of a bulk change (section 6): `DELETE FROM t AS t USING unnest(...) AS x(c0) WHERE t."k" = CAST(x.c0 AS integer)`. */
function keyedDelete(table: string, key: readonly Column[]): string {
  const arrays = key.map((_, i) => `$${i + 1}::text[]`).join(", ");
  const aliases = key.map((_, i) => `c${i}`).join(", ");
  const where = key
    .map(([name, type], i) => `t."${name}" = CAST(x.c${i} AS ${type})`)
    .join(" AND ");
  return `DELETE FROM ${table} AS t USING unnest(${arrays}) AS x(${aliases}) WHERE ${where}`;
}

const ITEM: readonly Column[] = [
  ["id", "integer"],
  ["name", "text"],
  ["qty", "integer"],
];
const SET_ITEM = `DO UPDATE SET "name" = EXCLUDED."name", "qty" = EXCLUDED."qty"`;

describe.skipIf(!testDatabaseUrl())(
  "keyed writes: ON CONFLICT and unnest batches (spike E0)",
  () => {
    beforeAll(async () => {
      await q(`
      CREATE SCHEMA u;
      CREATE TABLE u.item (id int PRIMARY KEY, name text NOT NULL, qty int);
      INSERT INTO u.item VALUES (1, 'one', 10), (2, 'two', 20), (3, 'three', 30);
      CREATE TABLE u.child (id int PRIMARY KEY, item_id int REFERENCES u.item (id));

      CREATE TABLE u.pair (a int, b text, v text, PRIMARY KEY (a, b));
      INSERT INTO u.pair VALUES (1, 'x', 'old'), (1, 'y', 'old');

      -- a partial unique index (a soft delete) and an expression index
      CREATE TABLE u.soft (id int PRIMARY KEY, email text NOT NULL, deleted boolean NOT NULL DEFAULT false);
      CREATE UNIQUE INDEX soft_live_email ON u.soft (email) WHERE NOT deleted;
      INSERT INTO u.soft VALUES (1, 'a@x.test', false), (2, 'a@x.test', true);
      CREATE TABLE u.lowered (id int PRIMARY KEY, email text NOT NULL);
      CREATE UNIQUE INDEX lowered_email ON u.lowered (lower(email));

      -- a nullable unique column next to the primary key
      CREATE TABLE u.coded (id int PRIMARY KEY, code text UNIQUE, v text);
      INSERT INTO u.coded VALUES (1, NULL, 'old'), (2, 'k2', 'old');

      -- a deferrable unique constraint, alone and next to a primary key
      CREATE TABLE u.deferred (id int, v text, CONSTRAINT deferred_id UNIQUE (id) DEFERRABLE INITIALLY IMMEDIATE);
      INSERT INTO u.deferred VALUES (1, 'old');
      CREATE TABLE u.mixed (id int PRIMARY KEY, code text, v text,
        CONSTRAINT mixed_code UNIQUE (code) DEFERRABLE INITIALLY IMMEDIATE);
      INSERT INTO u.mixed VALUES (1, 'c1', 'old');

      -- triggers of every kind, recorded in order
      CREATE TABLE u.audit (n serial, fired text, id int);
      CREATE TABLE u.watched (id int PRIMARY KEY, v text);
      INSERT INTO u.watched VALUES (1, 'old');
      CREATE FUNCTION u.note() RETURNS trigger LANGUAGE plpgsql AS $x$
        BEGIN INSERT INTO u.audit (fired, id) VALUES (TG_WHEN || ' ' || TG_OP, NEW.id); RETURN NEW; END; $x$;
      CREATE TRIGGER w1 BEFORE INSERT ON u.watched FOR EACH ROW EXECUTE FUNCTION u.note();
      CREATE TRIGGER w2 BEFORE UPDATE ON u.watched FOR EACH ROW EXECUTE FUNCTION u.note();
      CREATE TRIGGER w3 AFTER INSERT ON u.watched FOR EACH ROW EXECUTE FUNCTION u.note();
      CREATE TRIGGER w4 AFTER UPDATE ON u.watched FOR EACH ROW EXECUTE FUNCTION u.note();

      -- a partitioned table: its key must hold the partition column
      CREATE TABLE u.part (id int, d date, v text, PRIMARY KEY (id, d)) PARTITION BY RANGE (d);
      CREATE TABLE u.part_2026 PARTITION OF u.part FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
      CREATE TABLE u.part_2027 PARTITION OF u.part FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');
      INSERT INTO u.part VALUES (1, '2026-05-01', 'old');
    `);
    });

    // ------------------------------------------------------------------------------------------------ ON CONFLICT ---

    it("infers the arbiter from a primary key or a full unique constraint, single or composite, in any column order", async () => {
      await rolledBack(async () => {
        const single = await q(
          insertBatch(
            "u.item",
            ITEM,
            `ON CONFLICT ("id") ${SET_ITEM} RETURNING (xmax = 0) AS inserted`,
          ),
          columnsOf([
            ["2", "two again", "21"],
            ["4", "four", "40"],
          ]),
        );
        expect(single.rowCount).toBe(2);
        expect(single.rows.map((r) => r.inserted)).toEqual([false, true]);

        // A composite key named in another order than the constraint's: the target is a set of columns.
        const pair = await q(
          insertBatch(
            "u.pair",
            [
              ["a", "integer"],
              ["b", "text"],
              ["v", "text"],
            ],
            `ON CONFLICT ("b", "a") DO UPDATE SET "v" = EXCLUDED."v" RETURNING (xmax = 0) AS inserted`,
          ),
          columnsOf([
            ["1", "x", "new"],
            ["2", "x", "new"],
          ]),
        );
        expect(pair.rows.map((r) => r.inserted)).toEqual([false, true]);
        // A key that names only part of a composite key infers nothing.
        expect(
          await outcome(insertBatch("u.pair", [["a", "integer"]], `ON CONFLICT ("a") DO NOTHING`), [
            ["9"],
          ]),
        ).toBe("42P10");
      });
    });

    it("does not infer a partial unique index without its predicate, nor an expression index from a column list", async () => {
      await rolledBack(async () => {
        const soft: Column[] = [
          ["id", "integer"],
          ["email", "text"],
        ];
        expect(
          await outcome(insertBatch("u.soft", soft, `ON CONFLICT ("email") DO NOTHING`), [
            ["3"],
            ["a@x.test"],
          ]),
        ).toBe("42P10");
        // With the index's own predicate it is inferred (the plan leaves this out of the first version).
        expect(
          await outcome(
            insertBatch("u.soft", soft, `ON CONFLICT ("email") WHERE NOT deleted DO NOTHING`),
            [["3"], ["a@x.test"]],
          ),
        ).toBe("ok");
        expect(
          await outcome(
            insertBatch(
              "u.lowered",
              [
                ["id", "integer"],
                ["email", "text"],
              ],
              `ON CONFLICT ("email") DO NOTHING`,
            ),
            [["1"], ["A@x.test"]],
          ),
        ).toBe("42P10");
      });
    });

    it("refuses a DEFERRABLE unique constraint as the arbiter, and ignores one that is not the arbiter", async () => {
      await rolledBack(async () => {
        const cols: Column[] = [
          ["id", "integer"],
          ["v", "text"],
        ];
        for (const tail of [
          `ON CONFLICT ("id") DO UPDATE SET "v" = EXCLUDED."v"`,
          `ON CONFLICT ("id") DO NOTHING`,
          // No target: every unique index is an arbiter, the deferrable one too.
          `ON CONFLICT DO NOTHING`,
        ]) {
          expect(await outcome(insertBatch("u.deferred", cols, tail), [["1"], ["new"]])).toBe(
            "55000",
          );
        }
        // The primary key is the arbiter; the deferrable unique constraint beside it is checked as usual.
        expect(
          await outcome(
            insertBatch("u.mixed", cols, `ON CONFLICT ("id") DO UPDATE SET "v" = EXCLUDED."v"`),
            [["1"], ["new"]],
          ),
        ).toBe("ok");
      });
    });

    it("never conflicts on NULL in a nullable unique column, and a conflict on another key is an error", async () => {
      await rolledBack(async () => {
        const cols: Column[] = [
          ["id", "integer"],
          ["code", "text"],
          ["v", "text"],
        ];
        const upsert = insertBatch(
          "u.coded",
          cols,
          `ON CONFLICT ("code") DO UPDATE SET "v" = EXCLUDED."v" RETURNING (xmax = 0) AS inserted`,
        );
        // Row 1 already has code NULL: a second NULL is a new row, not an update of it.
        const nulls = await q(upsert, columnsOf([["3", null, "new"]]));
        expect(nulls.rows.map((r) => r.inserted)).toEqual([true]);
        expect(
          (await q("SELECT count(*)::int AS n FROM u.coded WHERE code IS NULL")).rows[0]!.n,
        ).toBe(2);
        // A new code whose id is already taken: the primary key is not the arbiter, so it is a unique violation.
        expect(await outcome(upsert, columnsOf([["2", "k9", "new"]]))).toBe("23505");
      });
    });

    it("conflicts on NULL with NULLS NOT DISTINCT (PostgreSQL 15 and later)", async (context) => {
      if (serverVersion < 150000) context.skip();
      await rolledBack(async () => {
        await q(
          "CREATE TABLE u.nnd (id int PRIMARY KEY, code text, v text, CONSTRAINT nnd_code UNIQUE NULLS NOT DISTINCT (code))",
        );
        await q("INSERT INTO u.nnd VALUES (1, NULL, 'old')");
        const result = await q(
          insertBatch(
            "u.nnd",
            [
              ["id", "integer"],
              ["code", "text"],
              ["v", "text"],
            ],
            `ON CONFLICT ("code") DO UPDATE SET "v" = EXCLUDED."v" RETURNING (xmax = 0) AS inserted`,
          ),
          columnsOf([["2", null, "new"]]),
        );
        expect(result.rows.map((r) => r.inserted)).toEqual([false]);
        expect((await q("SELECT count(*)::int AS n FROM u.nnd")).rows[0]!.n).toBe(1);
      });
    });

    it("counts inserted and updated rows with RETURNING (xmax = 0); rowCount is every row with DO UPDATE, the new ones with DO NOTHING", async () => {
      const rows = columnsOf([
        ["1", "one'", "11"],
        ["4", "four", "40"],
        ["2", "two'", "21"],
        ["5", "five", "50"],
        ["6", "six", "60"],
      ]);
      await rolledBack(async () => {
        const update = await q(
          insertBatch(
            "u.item",
            ITEM,
            `ON CONFLICT ("id") ${SET_ITEM} RETURNING (xmax = 0) AS inserted`,
          ),
          rows,
        );
        expect(update.rowCount).toBe(5);
        expect(update.rows.filter((r) => r.inserted)).toHaveLength(3);
        expect(update.rows.filter((r) => !r.inserted)).toHaveLength(2);
      });
      await rolledBack(async () => {
        const nothing = await q(
          insertBatch(
            "u.item",
            ITEM,
            `ON CONFLICT ("id") DO NOTHING RETURNING (xmax = 0) AS inserted`,
          ),
          rows,
        );
        expect(nothing.rowCount).toBe(3);
        expect(nothing.rows.every((r) => r.inserted)).toBe(true);
      });
      await rolledBack(async () => {
        // Counted in the database: one row comes back, so rowCount is 1 and the check must read the counts instead.
        const counted = await q(
          `WITH w AS (${insertBatch("u.item", ITEM, `ON CONFLICT ("id") ${SET_ITEM} RETURNING (xmax = 0) AS inserted`)}) ` +
            "SELECT count(*) FILTER (WHERE inserted)::int AS inserted, count(*) FILTER (WHERE NOT inserted)::int AS updated FROM w",
          rows,
        );
        expect(counted.rowCount).toBe(1);
        expect(counted.rows[0]).toEqual({ inserted: 3, updated: 2 });
      });
      await rolledBack(async () => {
        // DO UPDATE with a WHERE (say "only when something changed") leaves rows out of rowCount.
        const unchanged = await q(
          insertBatch(
            "u.item AS t",
            ITEM,
            `ON CONFLICT ("id") ${SET_ITEM} WHERE (t."name", t."qty") IS DISTINCT FROM (EXCLUDED."name", EXCLUDED."qty")`,
          ),
          columnsOf([
            ["1", "one", "10"],
            ["2", "changed", "20"],
            ["7", "seven", "70"],
          ]),
        );
        expect(unchanged.rowCount).toBe(2);
      });
    });

    it("reads xmax as 'updated' for a row inserted by an earlier batch of the same transaction, and for a row another session holds a key-share lock on", async () => {
      const upsert = insertBatch(
        "u.item",
        ITEM,
        `ON CONFLICT ("id") ${SET_ITEM} RETURNING (xmax = 0) AS inserted`,
      );
      await rolledBack(async () => {
        const first = await q(upsert, columnsOf([["50", "fifty", "1"]]));
        const second = await q(upsert, columnsOf([["50", "fifty again", "2"]]));
        expect(first.rows[0]!.inserted).toBe(true);
        expect(second.rows[0]!.inserted).toBe(false);
      });

      // Another session adds a child row of item 1 and keeps its transaction open: item 1 is locked FOR KEY SHARE.
      const { host, port, username, password } = db.connection;
      const other = new pg.Client({ host, port, user: username, password, database: db.dbName });
      await other.connect();
      try {
        await other.query("BEGIN");
        await other.query("INSERT INTO u.child VALUES (1, 1)");
        await rolledBack(async () => {
          await q("SET LOCAL lock_timeout = '2s'");
          // Updating columns that are not the key does not wait for a key-share lock, and the row reads as updated.
          const result = await q(upsert, columnsOf([["1", "one'", "11"]]));
          expect(result.rows.map((r) => r.inserted)).toEqual([false]);
        });
      } finally {
        await other.query("ROLLBACK").catch(() => {});
        await other.end();
      }
    });

    it("needs SELECT on the key columns for a conflict target, on the updated columns for DO UPDATE, and on the TABLE for xmax", async () => {
      await rolledBack(async () => {
        await q("CREATE ROLE e0_upsert NOLOGIN");
        await q("GRANT USAGE ON SCHEMA u TO e0_upsert");
        await q("GRANT INSERT, UPDATE ON u.item TO e0_upsert");
        await q("SET LOCAL ROLE e0_upsert");
        const nothing = insertBatch("u.item", ITEM, `ON CONFLICT ("id") DO NOTHING`);
        const update = insertBatch("u.item", ITEM, `ON CONFLICT ("id") ${SET_ITEM}`);
        const counted = `${update} RETURNING (xmax = 0) AS inserted`;
        const row = columnsOf([["90", "ninety", "9"]]);
        expect(await outcome(nothing, row)).toBe("42501");
        expect(await outcome(update, row)).toBe("42501");
        await q("RESET ROLE");
        await q('GRANT SELECT ("id") ON u.item TO e0_upsert');
        await q("SET LOCAL ROLE e0_upsert");
        expect(await outcome(nothing, row)).toBe("ok");
        // EXCLUDED."name" reads the column: SELECT on it too.
        expect(await outcome(update, row)).toBe("42501");
        await q("RESET ROLE");
        await q('GRANT SELECT ("name", "qty") ON u.item TO e0_upsert');
        await q("SET LOCAL ROLE e0_upsert");
        expect(await outcome(update, row)).toBe("ok");
        // xmax is a system column: a grant on every user column is not enough.
        expect(await outcome(counted, row)).toBe("42501");
        await q("RESET ROLE");
      });
    });

    it("fires BEFORE INSERT for every row of the batch, then BEFORE and AFTER UPDATE for the ones that conflict", async () => {
      await rolledBack(async () => {
        await q(
          insertBatch(
            "u.watched",
            [
              ["id", "integer"],
              ["v", "text"],
            ],
            `ON CONFLICT ("id") DO UPDATE SET "v" = EXCLUDED."v"`,
          ),
          columnsOf([
            ["1", "new"],
            ["2", "new"],
          ]),
        );
        const fired = (await q("SELECT fired, id FROM u.audit ORDER BY n")).rows.map(
          (r) => `${r.fired} ${r.id}`,
        );
        expect(fired.filter((f) => f.startsWith("BEFORE INSERT")).sort()).toEqual([
          "BEFORE INSERT 1",
          "BEFORE INSERT 2",
        ]);
        expect(fired).toContain("BEFORE UPDATE 1");
        expect(fired).toContain("AFTER UPDATE 1");
        expect(fired).toContain("AFTER INSERT 2");
        expect(fired).not.toContain("AFTER INSERT 1");
        expect(fired).not.toContain("BEFORE UPDATE 2");
      });
    });

    it("upserts a partitioned table by its key (which holds the partition column), but cannot return xmax from it", async () => {
      await rolledBack(async () => {
        const upsert = insertBatch(
          "u.part",
          [
            ["id", "integer"],
            ["d", "date"],
            ["v", "text"],
          ],
          `ON CONFLICT ("id", "d") DO UPDATE SET "v" = EXCLUDED."v"`,
        );
        const rows = columnsOf([
          ["1", "2026-05-01", "new"],
          ["2", "2027-02-01", "new"],
        ]);
        // "cannot retrieve a system column in this context": the inserted-or-updated count must come from elsewhere.
        expect(await outcome(`${upsert} RETURNING (xmax = 0) AS inserted`, rows)).toBe("0A000");
        expect((await q(upsert, rows)).rowCount).toBe(2);
        expect((await q("SELECT v FROM u.part ORDER BY id")).rows.map((r) => r.v)).toEqual([
          "new",
          "new",
        ]);
      });
    });

    it("two rows of one batch with the same key: DO UPDATE fails (21000), DO NOTHING keeps the first and is one row short", async () => {
      await rolledBack(async () => {
        const twice = columnsOf([
          ["8", "a", "1"],
          ["8", "b", "2"],
        ]);
        expect(
          await outcome(insertBatch("u.item", ITEM, `ON CONFLICT ("id") ${SET_ITEM}`), twice),
        ).toBe("21000");
        const existingTwice = columnsOf([
          ["1", "a", "1"],
          ["1", "b", "2"],
        ]);
        expect(
          await outcome(
            insertBatch("u.item", ITEM, `ON CONFLICT ("id") ${SET_ITEM}`),
            existingTwice,
          ),
        ).toBe("21000");
        const nothing = await q(
          insertBatch("u.item", ITEM, `ON CONFLICT ("id") DO NOTHING`),
          twice,
        );
        expect(nothing.rowCount).toBe(1);
        expect((await q("SELECT name FROM u.item WHERE id = 8")).rows[0]!.name).toBe("a");
      });
    });

    // ------------------------------------------------------------------------------------- UPDATE / DELETE by key ---

    it("UPDATE ... FROM unnest: rowCount is the rows touched; a missing key is short, a key carried twice counts once", async () => {
      const update = keyedUpdate("u.item", [["id", "integer"]], [["name", "text"]]);
      await rolledBack(async () => {
        expect(
          (
            await q(update, [
              ["1", "2", "3"],
              ["a", "b", "c"],
            ])
          ).rowCount,
        ).toBe(3);
        expect(
          (
            await q(update, [
              ["1", "2", "99"],
              ["a", "b", "c"],
            ])
          ).rowCount,
        ).toBe(2);
        expect(
          (
            await q(update, [
              [null, "2"],
              ["a", "b"],
            ])
          ).rowCount,
        ).toBe(1);
        // The same key twice: the row is updated once, with one of the two values (which one is not defined).
        const twice = await q(update, [
          ["1", "1", "2"],
          ["first", "second", "c"],
        ]);
        expect(twice.rowCount).toBe(2);
        expect(["first", "second"]).toContain(
          (await q("SELECT name FROM u.item WHERE id = 1")).rows[0]!.name,
        );
        // A composite key, and a key that does not cast (the whole statement fails, as the import batch does).
        const pair = keyedUpdate(
          "u.pair",
          [
            ["a", "integer"],
            ["b", "text"],
          ],
          [["v", "text"]],
        );
        expect(
          (
            await q(pair, [
              ["1", "1"],
              ["x", "z"],
              ["new", "new"],
            ])
          ).rowCount,
        ).toBe(1);
        expect(await outcome(update, [["one"], ["a"]])).toBe("22P02");
      });
    });

    it("DELETE ... USING unnest: rowCount is the rows deleted; a missing key is short, a key carried twice counts once", async () => {
      await rolledBack(async () => {
        expect(
          (await q(keyedDelete("u.item", [["id", "integer"]]), [["1", "99", "1"]])).rowCount,
        ).toBe(1);
        const pair = keyedDelete("u.pair", [
          ["a", "integer"],
          ["b", "text"],
        ]);
        expect(
          (
            await q(pair, [
              ["1", "1"],
              ["x", "y"],
            ])
          ).rowCount,
        ).toBe(2);
        // A row still referenced: the foreign key refuses the delete, as it does for one row.
        await q("INSERT INTO u.child VALUES (1, 2)");
        expect(await outcome(keyedDelete("u.item", [["id", "integer"]]), [["2"]])).toBe("23503");
      });
    });
  },
);

// Opt-in (DC_SPIKE=1): it builds 200,000 rows and logs timings, so it stays out of the release suite.
describe.skipIf(!testDatabaseUrl() || !process.env.DC_SPIKE)(
  "keyed batches on 100,000 rows: timings (spike E0)",
  () => {
    const BATCH = 500;
    const ROWS = 100_000;
    beforeAll(async () => {
      await q(`
        CREATE SCHEMA big;
        CREATE TABLE big.t (id int PRIMARY KEY, code text NOT NULL UNIQUE, v text, n int);
        INSERT INTO big.t SELECT g, 'code-' || g, 'v' || g, g FROM generate_series(1, 200000) g;
        ANALYZE big.t;
      `);
    }, 120_000);

    /** Run one statement per batch of `keys`, each checked for `expectRows`, all in one rolled-back transaction. */
    async function timed(
      label: string,
      keys: string[],
      text: string,
      arrays: (slice: string[]) => Array<Array<string | null>>,
      expectRows: (slice: string[]) => number,
    ): Promise<number> {
      return rolledBack(async () => {
        const started = performance.now();
        for (let at = 0; at < keys.length; at += BATCH) {
          const slice = keys.slice(at, at + BATCH);
          const result = await q(text, arrays(slice));
          expect(result.rowCount).toBe(expectRows(slice));
        }
        const ms = performance.now() - started;
        console.log(
          `keyed spike: ${label}: ${keys.length} rows in ${keys.length / BATCH} batches, ${(ms / 1000).toFixed(2)} s`,
        );
        return ms;
      });
    }

    it("plans one batch as a join on the key's index, not a scan of the table", async () => {
      const keys = Array.from({ length: BATCH }, (_, i) => String(i * 2 + 1));
      const plan = await q(
        `EXPLAIN (FORMAT JSON) ${keyedUpdate("big.t", [["id", "integer"]], [["v", "text"]])}`,
        [keys, keys.map(() => "x")],
      );
      type PlanNode = {
        "Node Type": string;
        "Relation Name"?: string;
        "Index Name"?: string;
        Plans?: PlanNode[];
      };
      const nodes: PlanNode[] = [];
      const walk = (node: PlanNode) => {
        nodes.push(node);
        node.Plans?.forEach(walk);
      };
      walk((plan.rows[0]!["QUERY PLAN"] as Array<{ Plan: PlanNode }>)[0]!.Plan);
      console.log(
        `keyed spike: plan of one UPDATE batch: ${nodes.map((n) => [n["Node Type"], n["Relation Name"], n["Index Name"]].filter(Boolean).join(" ")).join(" > ")}`,
      );
      expect(nodes.some((n) => n["Index Name"] === "t_pkey")).toBe(true);
      expect(nodes.some((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "t")).toBe(
        false,
      );
    });

    it("updates, deletes and upserts 100,000 rows in batches of 500, each batch counted", async () => {
      // Every other row, so the keys are spread over the whole table.
      const keys = Array.from({ length: ROWS }, (_, i) => String(i * 2 + 1));
      const update = await timed(
        "UPDATE ... FROM unnest by key",
        keys,
        keyedUpdate("big.t", [["id", "integer"]], [["v", "text"]]),
        (slice) => [slice, slice.map(() => "changed")],
        (slice) => slice.length,
      );
      const byText = await timed(
        "UPDATE ... FROM unnest by a text key",
        keys.map((k) => `code-${k}`),
        keyedUpdate("big.t", [["code", "text"]], [["v", "text"]]),
        (slice) => [slice, slice.map(() => "changed")],
        (slice) => slice.length,
      );
      const remove = await timed(
        "DELETE ... USING unnest by key",
        keys,
        keyedDelete("big.t", [["id", "integer"]]),
        (slice) => [slice],
        (slice) => slice.length,
      );
      // Half the rows exist (odd ids up to 100,000), half are new (ids above 200,000).
      const mixed = Array.from({ length: ROWS }, (_, i) =>
        String(i % 2 === 0 ? i + 1 : 200_000 + i),
      );
      const columns: Column[] = [
        ["id", "integer"],
        ["code", "text"],
        ["v", "text"],
        ["n", "integer"],
      ];
      const upsert = await timed(
        "INSERT ... ON CONFLICT DO UPDATE RETURNING (xmax = 0)",
        mixed,
        insertBatch(
          "big.t",
          columns,
          `ON CONFLICT ("id") DO UPDATE SET "code" = EXCLUDED."code", "v" = EXCLUDED."v", "n" = EXCLUDED."n" RETURNING (xmax = 0) AS inserted`,
        ),
        (slice) => [slice, slice.map((k) => `code-${k}`), slice.map(() => "up"), slice],
        (slice) => slice.length,
      );
      // Seconds, not minutes (logged above; only a loose bound is asserted, as the machine's load varies).
      for (const ms of [update, byText, remove, upsert]) expect(ms).toBeLessThan(120_000);
    }, 600_000);
  },
);
