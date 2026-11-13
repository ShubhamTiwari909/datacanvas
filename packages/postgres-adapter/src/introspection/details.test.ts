import { describe, expect, it } from "vitest";
import { loadTablesDetails } from "./details.js";
import type { Queryable } from "./types.js";

/**
 * A fake database that records every query. The first query of loadTablesDetails
 * asks for the table descriptions; the fake answers it with one row per requested
 * table (read back from the `unnest` parameters) and answers everything else with
 * no rows.
 */
function fakeDatabase(): { db: Queryable; queries: string[] } {
  const queries: string[] = [];
  const db: Queryable = {
    async query<Row>(text: string, values?: unknown[]) {
      queries.push(text);
      if (text.includes("c.relkind::text AS relkind")) {
        const [schemas, names] = values as [string[], string[]];
        const rows = names.map((name, i) => ({
          schema: schemas[i],
          name,
          relkind: "r",
          comment: null,
          reltuples: 10,
        }));
        return { rows: rows as Row[] };
      }
      return { rows: [] as Row[] };
    },
  };
  return { db, queries };
}

const tables = (n: number) =>
  Array.from({ length: n }, (_v, i) => ({ schema: "public", name: `t${i}` }));

describe("loadTablesDetails", () => {
  it("uses the same four queries for 1 table and for 200", async () => {
    for (const n of [1, 200]) {
      const { db, queries } = fakeDatabase();
      const result = await loadTablesDetails(db, tables(n));
      expect(result).toHaveLength(n);
      expect(queries, `${n} tables`).toHaveLength(4);
    }
  });

  it("runs no queries at all for an empty list", async () => {
    const { db, queries } = fakeDatabase();
    await expect(loadTablesDetails(db, [])).resolves.toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it("passes the tables as bound parameters, never inside the SQL text", async () => {
    const seen: Array<{ text: string; values: unknown[] | undefined }> = [];
    const db: Queryable = {
      async query<Row>(text: string, values?: unknown[]) {
        seen.push({ text, values });
        return { rows: [] as Row[] };
      },
    };
    const hostile = { schema: "public", name: "x'; DROP TABLE users; --" };
    await expect(loadTablesDetails(db, [hostile])).rejects.toMatchObject({ code: "not_found" });
    expect(seen[0]?.text).not.toContain("DROP TABLE");
    expect(seen[0]?.values?.[1]).toEqual([hostile.name]);
  });

  it("collapses duplicates and keeps the requested order", async () => {
    const { db } = fakeDatabase();
    const result = await loadTablesDetails(db, [
      { schema: "public", name: "b" },
      { schema: "public", name: "a" },
      { schema: "public", name: "b" },
    ]);
    expect(result.map((entry) => entry.table.name)).toEqual(["b", "a"]);
  });

  it("fails as a whole when a table has no description row", async () => {
    const db: Queryable = {
      async query<Row>() {
        return { rows: [] as Row[] };
      },
    };
    await expect(loadTablesDetails(db, tables(2))).rejects.toMatchObject({ code: "not_found" });
  });
});
