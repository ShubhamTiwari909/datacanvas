import { describe, expect, it } from "vitest";
import { searchTables } from "./search.js";

const tables = [
  "public.users",
  "public.user_profiles",
  "public.orders",
  "public.order_items",
  "analytics.daily_users",
].map((label) => ({ id: label, label }));

describe("searchTables", () => {
  it("matches nothing for a blank query", () => {
    expect(searchTables("", tables)).toEqual([]);
    expect(searchTables("   ", tables)).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(searchTables("ORDERS", tables).map((t) => t.label)).toContain("public.orders");
  });

  it("ranks exact, then prefix, then word start, then substring", () => {
    const labels = searchTables("users", tables).map((t) => t.label);
    // "public.users" has the word "users" as its second part; "analytics.daily_users" ends in it.
    expect(labels).toEqual(["public.users", "analytics.daily_users"]);
  });

  it("finds a word inside an underscored name", () => {
    expect(searchTables("items", tables).map((t) => t.label)).toEqual(["public.order_items"]);
  });

  it("respects the limit", () => {
    expect(searchTables("p", tables, 2)).toHaveLength(2);
  });

  it("returns nothing when nothing matches", () => {
    expect(searchTables("zzz", tables)).toEqual([]);
  });
});
