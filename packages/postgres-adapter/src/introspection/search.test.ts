import { describe, expect, it } from "vitest";
import { MAX_SEARCH_LIMIT, searchObjects } from "./search.js";
import type { Queryable } from "./types.js";

function recorder(): {
  db: Queryable;
  calls: Array<{ text: string; values: unknown[] | undefined }>;
} {
  const calls: Array<{ text: string; values: unknown[] | undefined }> = [];
  return {
    calls,
    db: {
      async query<Row>(text: string, values?: unknown[]) {
        calls.push({ text, values });
        return { rows: [] as Row[] };
      },
    },
  };
}

describe("searchObjects (unit)", () => {
  it("runs no query for a blank search", async () => {
    const { db, calls } = recorder();
    expect(await searchObjects(db, "   ", 10)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("runs exactly two queries (tables, columns) and passes the text as a bound parameter", async () => {
    const { db, calls } = recorder();
    const hostile = "x'; DROP TABLE users; --";
    await searchObjects(db, hostile, 10);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.text).not.toContain("DROP TABLE");
      expect(call.values?.[0]).toBe(hostile);
    }
  });

  it("trims the query and clamps the limit to a sane range", async () => {
    const { db, calls } = recorder();
    await searchObjects(db, "  order  ", 100000);
    expect(calls[0]?.values).toEqual(["order", ["r", "p", "v", "m", "f"], MAX_SEARCH_LIMIT]);
    await searchObjects(db, "order", 0);
    expect(calls[2]?.values?.[2]).toBe(1);
  });
});
