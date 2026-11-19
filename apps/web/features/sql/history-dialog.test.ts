import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "@/stores/sql-store";
import { filterHistory } from "./history-dialog";

const entry = (id: string, text: string): HistoryEntry => ({
  id,
  text,
  at: 0,
  tabName: "Query 1",
  outcome: "ok",
  code: null,
  rows: 1,
  elapsedMs: 1,
});
const history = [
  entry("h-3", "SELECT email FROM users WHERE id = 1"),
  entry("h-2", "select * from orders"),
  entry("h-1", "EXPLAIN SELECT * FROM users"),
];

describe("filterHistory", () => {
  it("keeps everything for an empty search, in the order given", () => {
    expect(filterHistory(history, "  ").map((h) => h.id)).toEqual(["h-3", "h-2", "h-1"]);
  });

  it("matches words in any order and any case", () => {
    expect(filterHistory(history, "USERS select").map((h) => h.id)).toEqual(["h-3", "h-1"]);
    expect(filterHistory(history, "orders").map((h) => h.id)).toEqual(["h-2"]);
  });

  it("finds nothing for what is not there", () => {
    expect(filterHistory(history, "zzz")).toEqual([]);
  });
});
