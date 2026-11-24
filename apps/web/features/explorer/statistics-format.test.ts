import type { ColumnStatistics, TableStatistics } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  deadRowsNote,
  distinctWords,
  formatBytes,
  formatShare,
  freshness,
  orderWords,
  when,
} from "./statistics-format";

const stats = (over: Partial<TableStatistics> = {}): TableStatistics => ({
  table: { schema: "public", name: "t" },
  kind: "table",
  estimatedRows: 1000,
  liveRows: 1000,
  deadRows: 0,
  tableBytes: 8192,
  indexBytes: 0,
  toastBytes: 0,
  lastVacuum: null,
  lastAutovacuum: null,
  lastAnalyze: null,
  lastAutoanalyze: null,
  columns: [],
  ...over,
});
const col = (over: Partial<ColumnStatistics>): ColumnStatistics => ({
  column: "c",
  hasStatistics: true,
  nullFraction: 0,
  distinctValues: null,
  distinctShare: null,
  averageWidth: 4,
  correlation: 0,
  ...over,
});

describe("sizes and shares", () => {
  it("writes bytes in the unit a person reads", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(8192)).toBe("8 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5_300_000)).toBe("5.1 MB");
    expect(formatBytes(12 * 1024 ** 3)).toBe("12 GB");
  });

  it("writes a share as a percentage, with a decimal only where it matters", () => {
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(0.5)).toBe("50%");
    expect(formatShare(0.004)).toBe("0.4%");
    expect(formatShare(0.057)).toBe("5.7%");
    expect(formatShare(1)).toBe("100%");
  });
});

describe("what a column's figures say", () => {
  it("says distinct values as a count, as every row, as a share, or as unknown", () => {
    expect(distinctWords(col({ distinctValues: 1234 }))).toBe("1,234 distinct");
    expect(distinctWords(col({ distinctShare: 1 }))).toBe("all different");
    expect(distinctWords(col({ distinctShare: 0.4 }))).toBe("40% of the rows differ");
    expect(distinctWords(col({}))).toBe("unknown");
  });

  it("says order in words", () => {
    expect(orderWords(1)).toBe("in order");
    expect(orderWords(-0.95)).toBe("in reverse order");
    expect(orderWords(0.5)).toBe("partly in order");
    expect(orderWords(0.1)).toBe("no order");
    expect(orderWords(null)).toBe("unknown");
  });
});

describe("how fresh the figures are", () => {
  const now = new Date("2026-11-24T12:00:00Z");

  it("says a table that was never analysed has no figures, and the planner guesses", () => {
    const f = freshness(stats(), now);
    expect(f.lastAnalyzed).toBeNull();
    expect(f.note).toMatch(/never been analysed.*guessing/);
  });

  it("uses the newer of the two analyses, and is quiet when it is recent", () => {
    const f = freshness(
      stats({ lastAnalyze: "2026-11-01T00:00:00Z", lastAutoanalyze: "2026-11-23T00:00:00Z" }),
      now,
    );
    expect(f.lastAnalyzed).toBe("2026-11-23T00:00:00Z");
    expect(f.note).toBeNull();
  });

  it("warns when the figures are a month old or more", () => {
    const f = freshness(stats({ lastAutoanalyze: "2026-09-01T00:00:00Z" }), now);
    expect(f.note).toBe("The figures are 84 days old. ANALYZE makes them again.");
  });

  it("warns about dead rows only when there are many and they are a fifth of the table", () => {
    expect(deadRowsNote(stats({ deadRows: 10, liveRows: 20 }))).toBeNull();
    expect(deadRowsNote(stats({ deadRows: 5000, liveRows: 100_000 }))).toBeNull();
    expect(deadRowsNote(stats({ deadRows: 30_000, liveRows: 100_000 }))).toMatch(
      /30,000 dead rows \(23% of the table\)/,
    );
    expect(deadRowsNote(stats({ deadRows: null, liveRows: null }))).toBeNull();
  });

  it("writes a time, or never", () => {
    expect(when(null)).toBe("never");
    expect(when("2026-11-24T12:00:00Z")).toMatch(/2026/);
  });
});
