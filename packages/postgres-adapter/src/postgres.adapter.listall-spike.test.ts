/**
 * Spike E0 of the write side, second part (`docs/write-side-v2-plan.md`, sections 4.3 and 13): what it costs the
 * validation to find EVERY failing row of a large import (the `listAll` of E1), so that its limit is set by a
 * measurement. It runs the real validation code (`validateRows`, halving the batch with savepoints) with `listAll`,
 * which searches on to the last failing row up to `VALIDATE_LIST_ALL_MAX_FAILURES` (1,000) and says `stopped_early`
 * past it, on a file of 100,000 rows with 0 to 2,000 failing rows, and reports the wall time and the number of
 * database round trips.
 *
 * Opt-in (DC_SPIKE=1): it validates 100,000 rows a dozen times and logs timings, so it stays out of the release suite.
 */
import {
  VALIDATE_LIST_ALL_MAX_FAILURES,
  VALIDATE_LIST_ALL_TIMEOUT_MS,
} from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";
import { validateRows } from "./validation/validate-rows.js";

const ROWS = 100_000;

let db: TestDatabase;
let pool: pg.Pool;

beforeAll(async () => {
  if (!testDatabaseUrl() || !process.env.DC_SPIKE) return;
  db = await createTestDatabase();
  const { host, port, username, password } = db.connection;
  pool = new pg.Pool({ host, port, user: username, password, database: db.dbName, max: 1 });
  // The table already holds 100,000 rows, so the uniqueness questions read a table of a realistic size.
  await pool.query(`
    CREATE TABLE public.imp (
      id int PRIMARY KEY,
      name text NOT NULL,
      qty int CHECK (qty >= 0),
      price numeric(8,2),
      made date
    );
    INSERT INTO public.imp SELECT g, 'old ' || g, g % 50, g % 1000 / 10.0, DATE '2025-01-01' + g % 365
      FROM generate_series(1, ${ROWS}) g;
    ANALYZE public.imp;
  `);
}, 180_000);
afterAll(async () => {
  await pool?.end().catch(() => {});
  await db?.dispose().catch(() => {});
});

/** A pool whose one connection counts the round trips made through it. */
function counting(real: pg.Pool): { pool: pg.Pool; roundTrips: () => number } {
  let queries = 0;
  const wrapped = {
    async connect() {
      const client = await real.connect();
      return {
        query: (text: string, values?: unknown[]) => {
          queries += 1;
          return client.query(text, values);
        },
        release: (error?: Error) => client.release(error),
      };
    },
  };
  return { pool: wrapped as unknown as pg.Pool, roundTrips: () => queries };
}

type Kind = "check" | "type";

/**
 * The file: new ids, every value valid except in the failing rows. A "check" failure (qty -1) is classified from
 * its SQLSTATE alone; a "type" failure (a date that is not one, in the LAST column) is classified by casting the
 * row's cells one at a time, the costliest case.
 */
function file(failing: ReadonlySet<number>, kind: Kind): Array<Array<string | null>> {
  const rows: Array<Array<string | null>> = [];
  for (let i = 0; i < ROWS; i++) {
    const bad = failing.has(i);
    rows.push([
      String(ROWS + 1 + i),
      `name ${i}`,
      bad && kind === "check" ? "-1" : String(i % 50),
      ((i % 1000) / 10).toFixed(2),
      bad && kind === "type" ? "not a date" : "2026-01-15",
    ]);
  }
  return rows;
}

/** Failing rows spread evenly: the worst case for halving (the most slices fail at every level). */
const evenly = (k: number): Set<number> => {
  const step = Math.floor(ROWS / k);
  return new Set(Array.from({ length: k }, (_, i) => i * step + Math.floor(step / 2)));
};
/** Failing rows at random places (a fixed seed). */
const scattered = (k: number): Set<number> => {
  let seed = 12345;
  const out = new Set<number>();
  while (out.size < k) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    out.add(seed % ROWS);
  }
  return out;
};
/** Failing rows in one block: the best case. */
const clustered = (k: number): Set<number> =>
  new Set(Array.from({ length: k }, (_, i) => 40_000 + i));

interface Measured {
  label: string;
  failing: number;
  found: number;
  roundTrips: number;
  seconds: number;
  stopped: boolean;
}

async function measure(label: string, failing: Set<number>, kind: Kind): Promise<Measured> {
  const rows = file(failing, kind);
  const { pool: countingPool, roundTrips } = counting(pool);
  const started = performance.now();
  // A deadline far past the default, so the cost is measured rather than cut at 15 seconds.
  const report = await validateRows(countingPool, 600_000, {
    table: { schema: "public", name: "imp" },
    mode: "insert",
    columns: ["id", "name", "qty", "price", "made"],
    rows,
    // Every failing row is searched for and named, up to the limit (past it the report says `stopped_early`).
    listAll: true,
  });
  const seconds = (performance.now() - started) / 1000;
  const found = report.issues.reduce((n, issue) => n + issue.count, 0);
  const stopped = report.notChecked.includes("stopped_early");
  if (failing.size > VALIDATE_LIST_ALL_MAX_FAILURES) {
    // Past the limit the search stops: the file needs fixing, so its cost is bounded by the limit's.
    expect(stopped).toBe(true);
    expect(found).toBeGreaterThan(VALIDATE_LIST_ALL_MAX_FAILURES);
  } else {
    expect(stopped).toBe(false);
    expect(report.passed).toBe(ROWS - failing.size);
    expect(report.issues.flatMap((issue) => issue.rows).sort((a, b) => a - b)).toEqual(
      [...failing].map((index) => index + 1).sort((a, b) => a - b),
    );
  }
  const result = {
    label,
    failing: failing.size,
    found,
    roundTrips: roundTrips(),
    seconds,
    stopped,
  };
  console.log(
    `listAll spike: ${label.padEnd(16)} ${String(failing.size).padStart(5)} failing of ${ROWS}: ` +
      `${String(found).padStart(5)} found, ${String(result.roundTrips).padStart(6)} round trips, ${seconds.toFixed(2)} s` +
      (stopped ? "  (stopped early, past the limit)" : "") +
      (seconds * 1000 > VALIDATE_LIST_ALL_TIMEOUT_MS ? "  (past the import deadline)" : ""),
  );
  return result;
}

describe.skipIf(!testDatabaseUrl() || !process.env.DC_SPIKE)(
  "finding every failing row of 100,000 by halving (spike E0)",
  () => {
    it.each([
      { label: "valid file", kind: "check", failures: 0 },
      { label: "1,000 check failures", kind: "check", failures: 1000 },
      { label: "1,000 type failures", kind: "type", failures: 1000 },
    ] as const)(
      "release baseline: $label",
      async ({ label, kind, failures }) => {
        const result = await measure(label, failures === 0 ? new Set() : evenly(failures), kind);
        expect(result.found).toBe(failures);
      },
      600_000,
    );

    it("measures 0, 100, 500, 1,000 and 2,000 failing rows", async () => {
      const results: Measured[] = [];
      results.push(await measure("none", new Set(), "check"));
      for (const k of [100, 500, 1000, 2000]) {
        results.push(await measure("check, evenly", evenly(k), "check"));
      }
      for (const k of [100, 500, 1000, 2000]) {
        results.push(await measure("type, evenly", evenly(k), "type"));
      }
      results.push(await measure("check, scattered", scattered(1000), "check"));
      results.push(await measure("check, clustered", clustered(1000), "check"));
      for (const r of results.filter((m) => !m.stopped)) expect(r.found).toBe(r.failing);
      // Halving: about 2 x failures x log2(rows / failures) slices, a few round trips each, never one per row.
      for (const r of results.filter((m) => m.failing > 0)) {
        expect(r.roundTrips).toBeLessThan(r.failing * 4 * 2 * Math.log2(ROWS) + 100);
      }
    }, 1_200_000);
  },
);
