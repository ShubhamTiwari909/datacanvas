import type { RelationshipInfo } from "@datacanvas/database-core";
import { nodeIdFor } from "@datacanvas/canvas-engine";
import { describe, expect, it } from "vitest";
import { MAX_RELATED_ADDED, relatedTablesToAdd } from "./explore-actions";

const rel = (source: string, target: string): RelationshipInfo => ({
  name: `${source}_${target}_fkey`,
  source: { schema: "public", table: source, columns: ["x"] },
  target: { schema: "public", table: target, columns: ["id"] },
  cardinality: "many-to-one",
  onDelete: "no_action",
  onUpdate: "no_action",
});
const id = (name: string) => nodeIdFor({ schema: "public", name });
const names = (result: ReturnType<typeof relatedTablesToAdd>) => result.refs.map((r) => r.name);

// order_items -> orders -> users <- user_profiles ; order_items -> products ; addresses -> regions
const relationships = [
  rel("order_items", "orders"),
  rel("orders", "users"),
  rel("user_profiles", "users"),
  rel("order_items", "products"),
  rel("addresses", "regions"),
];

describe("relatedTablesToAdd", () => {
  it("adds the direct neighbours of the selection that are not on the canvas", () => {
    const result = relatedTablesToAdd(
      [id("orders")],
      new Set([id("orders")]),
      relationships,
      1,
      "both",
    );
    expect(names(result)).toEqual(["order_items", "users"]);
  });

  it("does not add tables that are already on the canvas", () => {
    const result = relatedTablesToAdd(
      [id("orders")],
      new Set([id("orders"), id("users")]),
      relationships,
      1,
      "both",
    );
    expect(names(result)).toEqual(["order_items"]);
  });

  it("expands by N hops, nearest first", () => {
    const result = relatedTablesToAdd(
      [id("orders")],
      new Set([id("orders")]),
      relationships,
      2,
      "both",
    );
    expect(names(result)).toEqual(["order_items", "users", "products", "user_profiles"]);
  });

  it("walks only parents ('outgoing') or only children ('incoming')", () => {
    const parents = relatedTablesToAdd(
      [id("order_items")],
      new Set([id("order_items")]),
      relationships,
      5,
      "outgoing",
    );
    expect(names(parents)).toEqual(["orders", "products", "users"]);
    const children = relatedTablesToAdd(
      [id("users")],
      new Set([id("users")]),
      relationships,
      5,
      "incoming",
    );
    expect(names(children)).toEqual(["orders", "user_profiles", "order_items"]);
  });

  it("finds related tables across the WHOLE database, not just those on the canvas", () => {
    const result = relatedTablesToAdd(
      [id("regions")],
      new Set([id("regions")]),
      relationships,
      1,
      "both",
    );
    expect(names(result)).toEqual(["addresses"]);
  });

  it("adds nothing for a table without relationships", () => {
    expect(
      relatedTablesToAdd([id("audit_log")], new Set([id("audit_log")]), relationships, 3, "both"),
    ).toEqual({ refs: [], found: 0 });
  });

  it("caps how many are added and reports how many were found", () => {
    const hub = Array.from({ length: MAX_RELATED_ADDED + 15 }, (_v, i) =>
      rel(`child_${String(i).padStart(3, "0")}`, "hub"),
    );
    const result = relatedTablesToAdd([id("hub")], new Set([id("hub")]), hub, 1, "incoming");
    expect(result.refs).toHaveLength(MAX_RELATED_ADDED);
    expect(result.found).toBe(MAX_RELATED_ADDED + 15);
  });
});
