/**
 * Spike E0 of the write side, second part (`docs/write-side-v2-plan.md`, sections 6 and 13): how much memory the keys
 * of a bulk change take while the plan holds them (up to 100,000 keys, capped at 8 MB of key text, a key value at
 * most 4,096 characters), and how long the preview's read of 100,001 keys takes. The numbers are logged; only loose
 * bounds are asserted, because the heap of a test process is not a precise instrument.
 *
 * Two shapes are measured: the keys as the chosen rows carry them (one `{ column, value }` per key column per row),
 * and as the keyed batches will bind them (one array of text per key column per batch of 500).
 *
 * Opt-in (DC_SPIKE=1): it builds about half a gigabyte of strings, so it stays out of the release suite.
 */
import v8 from "node:v8";
import vm from "node:vm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const KEYS = 100_000;
const BATCH = 500;
const CAP_CHARS = 8 * 1024 * 1024;
const LONG = 4096;

/** A full collection, made available without a flag on the command line. */
const gc: () => void =
  (globalThis as { gc?: () => void }).gc ??
  (() => {
    v8.setFlagsFromString("--expose-gc");
    return vm.runInNewContext("gc") as () => void;
  })();

const heapUsed = (): number => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};

/** Build something, keep it, and say how much the heap grew for it. */
function measure<T>(label: string, keys: number, chars: number, build: () => T): number {
  const before = heapUsed();
  const held = build();
  const after = heapUsed();
  const bytes = after - before;
  console.log(
    `held-keys spike: ${label.padEnd(46)} ${String(keys).padStart(6)} keys, ${(chars / 1e6).toFixed(2).padStart(6)} M chars: ` +
      `${(bytes / 1e6).toFixed(1).padStart(6)} MB (${Math.round(bytes / keys)} bytes a key)`,
  );
  // Keep `held` alive until after the second measurement.
  expect(held).toBeDefined();
  return bytes;
}

/** A flat one-byte (Latin-1) string of `length` characters, as the driver makes from the bytes of a text value. */
const oneByte = (i: number, length: number): string => {
  const buffer = Buffer.alloc(length, 0x61);
  buffer.write(String(i));
  return buffer.toString("latin1");
};
/** A flat two-byte string of `length` characters (a letter outside Latin-1), as a Cyrillic or CJK key would be. */
const twoByte = (i: number, length: number): string =>
  Buffer.from(String(i).padEnd(length, "ж"), "utf8").toString("utf8");

/** How many characters the keys `make(0)` to `make(count - 1)` hold. */
const charsOf = (count: number, make: (i: number) => string): number => {
  let chars = 0;
  for (let i = 0; i < count; i++) chars += make(i).length;
  return chars;
};
const intKey = (i: number): string => String(i * 2 + 1);

/** The keys of one column as the keyed batches bind them: one array of 500 per batch. */
function batched(count: number, make: (i: number) => string): string[][] {
  const batches: string[][] = [];
  for (let at = 0; at < count; at += BATCH) {
    const batch: string[] = [];
    for (let i = at; i < Math.min(count, at + BATCH); i++) batch.push(make(i));
    batches.push(batch);
  }
  return batches;
}

describe.skipIf(!process.env.DC_SPIKE)("the keys a bulk-change plan holds (spike E0)", () => {
  it("measures 100,000 keys of each kind, and the 8 MB cap", () => {
    const results: Record<string, number> = {};
    const intChars = charsOf(KEYS, intKey);
    results.intRows = measure("int keys, { column, value } per row", KEYS, intChars, () =>
      Array.from({ length: KEYS }, (_, i) => [{ column: "id", value: intKey(i) }]),
    );
    results.intBatches = measure("int keys, an array per batch", KEYS, intChars, () =>
      batched(KEYS, intKey),
    );
    results.pairBatches = measure(
      "(int, 12-char text) keys, arrays per batch",
      KEYS,
      intChars + KEYS * 12,
      () => [batched(KEYS, intKey), batched(KEYS, (i) => oneByte(i, 12))],
    );
    results.uuidBatches = measure("uuid keys (36 chars), an array per batch", KEYS, KEYS * 36, () =>
      batched(KEYS, (i) => oneByte(i, 36)),
    );
    const capped = CAP_CHARS / LONG;
    results.capOneByte = measure(
      `${capped} keys of 4,096 Latin-1 chars (the cap)`,
      capped,
      CAP_CHARS,
      () => batched(capped, (i) => oneByte(i, LONG)),
    );
    results.capTwoByte = measure(
      `${capped} keys of 4,096 non-Latin-1 chars (the cap)`,
      capped,
      CAP_CHARS,
      () => batched(capped, (i) => twoByte(i, LONG)),
    );
    results.uncapped = measure(
      "100,000 keys of 4,096 Latin-1 chars (no cap)",
      KEYS,
      KEYS * LONG,
      () => batched(KEYS, (i) => oneByte(i, LONG)),
    );

    // 100,000 ordinary keys are a few megabytes; the cap holds long keys to about 8 MB (16 MB when every character
    // takes two bytes); without it 100,000 long keys would be about 400 MB.
    expect(results.intBatches).toBeLessThan(16e6);
    expect(results.intRows).toBeLessThan(32e6);
    expect(results.capOneByte).toBeLessThan(12e6);
    expect(results.capTwoByte).toBeLessThan(24e6);
    expect(results.uncapped).toBeGreaterThan(300e6);
  }, 300_000);

  describe.skipIf(!testDatabaseUrl())("the preview's read of the keys", () => {
    let db: TestDatabase;
    let client: pg.Client;
    beforeAll(async () => {
      db = await createTestDatabase();
      const { host, port, username, password } = db.connection;
      client = new pg.Client({ host, port, user: username, password, database: db.dbName });
      await client.connect();
      await client.query(`
        CREATE TABLE public.big (id int PRIMARY KEY, n int, v text);
        INSERT INTO public.big SELECT g, g % 2, 'v' || g FROM generate_series(1, 250000) g;
        CREATE TABLE public.wide (k text PRIMARY KEY, n int);
        INSERT INTO public.wide SELECT lpad(g::text, ${LONG}, 'k'), g % 2 FROM generate_series(1, 5000) g;
        ANALYZE public.big; ANALYZE public.wide;
      `);
    }, 180_000);
    afterAll(async () => {
      await client?.end().catch(() => {});
      await db?.dispose().catch(() => {});
    });

    it("reads 100,001 keys of a filter in a read-only transaction, in well under a second", async () => {
      await client.query("BEGIN READ ONLY");
      try {
        const before = heapUsed();
        const started = performance.now();
        // The page reader's shape: the key columns only, the filter's condition bound, ordered by the key.
        const read = await client.query(
          "SELECT id FROM public.big WHERE n = $1 ORDER BY id LIMIT 100001",
          [0],
        );
        const ms = performance.now() - started;
        const after = heapUsed();
        console.log(
          `held-keys spike: read ${read.rowCount} int keys in ${ms.toFixed(0)} ms; the driver's rows take ${((after - before) / 1e6).toFixed(1)} MB (an int4 arrives as a number)`,
        );
        expect(read.rowCount).toBe(100_001);
        expect(typeof read.rows[0]!.id).toBe("number");

        const longStarted = performance.now();
        const wide = await client.query(
          `SELECT k FROM public.wide WHERE n = $1 ORDER BY k LIMIT ${CAP_CHARS / LONG + 1}`,
          [0],
        );
        const chars = wide.rows.reduce((sum: number, r: { k: string }) => sum + r.k.length, 0);
        console.log(
          `held-keys spike: read ${wide.rowCount} keys of 4,096 chars (${(chars / 1e6).toFixed(2)} M chars) in ${(performance.now() - longStarted).toFixed(0)} ms`,
        );
        expect(ms).toBeLessThan(10_000);
      } finally {
        await client.query("ROLLBACK");
      }
    }, 120_000);
  });
});
