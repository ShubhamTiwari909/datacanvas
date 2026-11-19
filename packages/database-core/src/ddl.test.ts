import { describe, expect, it } from "vitest";
import { ddlDifferences, emptyDdl, normalizeDdl, type DdlDetail } from "./ddl.js";

const base = (): DdlDetail => ({
  ...emptyDdl(160000),
  columns: [
    {
      schema: "public",
      table: "t",
      column: "id",
      identity: "always",
      generated: null,
      collation: null,
      collationSchema: null,
    },
  ],
  constraints: [
    {
      schema: "public",
      table: "t",
      name: "t_fk",
      deferrable: true,
      initiallyDeferred: false,
      validated: false,
      match: "full",
    },
  ],
  tables: [
    {
      schema: "public",
      name: "t",
      unlogged: true,
      partitionKey: null,
      partitionOf: null,
      inherits: [],
      options: ["fillfactor=70"],
      tablespace: null,
    },
  ],
  comments: [{ target: "index", schema: "public", table: "t", name: "t_idx", comment: "fast" }],
});

describe("ddlDifferences", () => {
  it("is empty for the same detail, whatever the order, and ignores the server version", () => {
    const a = base();
    const b = { ...base(), serverVersion: 120000, columns: [...base().columns].reverse() };
    expect(ddlDifferences(a, b)).toEqual([]);
  });

  it("names what was added, removed and changed", () => {
    const a = base();
    const b = base();
    b.columns[0]!.identity = "by_default";
    b.tables = [];
    b.comments.push({
      target: "schema",
      schema: "public",
      table: null,
      name: "public",
      comment: "x",
    });
    const lines = ddlDifferences(a, b);
    expect(lines.some((l) => l.startsWith("column public.t.id: "))).toBe(true);
    expect(lines.some((l) => l.startsWith("table public.t: only before"))).toBe(true);
    expect(lines.some((l) => l.startsWith("comment schema public..public: only after"))).toBe(true);
  });
});

describe("normalizeDdl", () => {
  it("orders each list by code unit, so the same database is the same value", () => {
    const d = base();
    d.columns.push({
      schema: "a",
      table: "z",
      column: "c",
      identity: null,
      generated: "stored",
      collation: "C",
      collationSchema: "pg_catalog",
    });
    expect(normalizeDdl(d).columns.map((c) => c.schema)).toEqual(["a", "public"]);
  });
});
