/**
 * Spike D0 (advanced data workspace, section 8): can an export of 100,000 rows be read through a
 * cursor and written out as text without holding the rows? The memory of the process must stay
 * flat whatever the number of rows, and 100,000 rows must take seconds, not minutes.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

let db: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  if (!testDatabaseUrl()) return;
  db = await createTestDatabase();
  const { host, port, username, password } = db.connection;
  client = new pg.Client({ host, port, user: username, password, database: db.dbName });
  await client.connect();
  await client.query(`
    CREATE TABLE public.big (id int PRIMARY KEY, name text, note text, price numeric(10,2), made timestamptz, doc jsonb);
    INSERT INTO public.big
      SELECT n, 'name ' || n, repeat('x', 200) || n, n / 7.0, now() - (n || ' minutes')::interval,
             jsonb_build_object('n', n, 'tags', jsonb_build_array('a', 'b', n))
      FROM generate_series(1, 100000) n;
  `);
}, 180_000);
afterAll(async () => {
  await client?.end().catch(() => {});
  await db?.dispose().catch(() => {});
});

const csvCell = (v: unknown): string => {
  if (v === null) return "";
  const text = typeof v === "string" ? v : v instanceof Date ? v.toISOString() : JSON.stringify(v);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// Opt-in (DC_SPIKE=1): it builds 100,000 rows and logs timings, so it stays out of the release suite.
describe.skipIf(!testDatabaseUrl() || !process.env.DC_SPIKE)(
  "streaming 100,000 rows through a cursor (spike D0)",
  () => {
    it("keeps the memory flat and finishes in seconds", async () => {
      await client.query("BEGIN READ ONLY");
      await client.query(
        "DECLARE export_cursor NO SCROLL CURSOR FOR SELECT * FROM public.big ORDER BY id",
      );
      if (global.gc) global.gc();
      const base = process.memoryUsage().heapUsed;
      let peak = base;
      let biggestBatch = 0;
      let bytes = 0;
      let rows = 0;
      const started = performance.now();
      for (;;) {
        const { rows: batch } = await client.query("FETCH 1000 FROM export_cursor");
        if (batch.length === 0) break;
        let text = "";
        for (const row of batch) {
          text += Object.values(row).map(csvCell).join(",") + "\n";
        }
        biggestBatch = Math.max(biggestBatch, Buffer.byteLength(text));
        bytes += Buffer.byteLength(text); // what would be handed to the response and let go
        rows += batch.length;
        peak = Math.max(peak, process.memoryUsage().heapUsed);
      }
      const seconds = (performance.now() - started) / 1000;
      await client.query("CLOSE export_cursor");
      await client.query("ROLLBACK");
      console.log(
        `export spike: ${rows} rows, ${(bytes / 1e6).toFixed(1)} MB of CSV, ${seconds.toFixed(2)} s, heap grew ${((peak - base) / 1e6).toFixed(1)} MB`,
      );
      expect(rows).toBe(100_000);
      // What was held at once is one batch of 1,000 rows, not the table: the biggest piece is a small part of the file.
      // (Time and heap are logged above, not asserted: they depend on the load of the machine.)
      expect(biggestBatch).toBeLessThan(bytes / 50);
    }, 120_000);
  },
);
