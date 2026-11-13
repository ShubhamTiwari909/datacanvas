import type { RelationshipInfo } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { COLLAPSED_COLUMN_LIMIT } from "./constants.js";
import { buildEdges, cardinalityLabel, type EdgeNode } from "./edges.js";
import { columnHandleId, nodeIdFor, tableHandleId } from "./ids.js";

const node = (name: string, columns: string[], expanded = false, schema = "public"): EdgeNode => ({
  schema,
  name,
  columns,
  expanded,
});

const fk = (
  name: string,
  source: [string, string[]],
  target: [string, string[]],
  overrides: Partial<RelationshipInfo> = {},
): RelationshipInfo => ({
  name,
  source: { schema: "public", table: source[0], columns: source[1] },
  target: { schema: "public", table: target[0], columns: target[1] },
  cardinality: "many-to-one",
  onDelete: "no_action",
  onUpdate: "no_action",
  ...overrides,
});

const orders = node("orders", ["id", "user_id"]);
const users = node("users", ["id", "email"]);
const ordersToUsers = fk("orders_user_id_fkey", ["orders", ["user_id"]], ["users", ["id"]]);

describe("buildEdges", () => {
  it("draws one edge between two tables on the canvas, attached to the key columns", () => {
    const [edge] = buildEdges([ordersToUsers], [orders, users]);
    expect(edge).toMatchObject({
      source: nodeIdFor({ schema: "public", name: "orders" }),
      target: nodeIdFor({ schema: "public", name: "users" }),
      sourceHandle: columnHandleId("source", "user_id"),
      targetHandle: columnHandleId("target", "id"),
      relationship: "orders_user_id_fkey",
      cardinality: "many-to-one",
      label: "N:1",
    });
  });

  it("draws nothing when either table is not on the canvas", () => {
    expect(buildEdges([ordersToUsers], [orders])).toEqual([]);
    expect(buildEdges([ordersToUsers], [users])).toEqual([]);
    expect(buildEdges([ordersToUsers], [])).toEqual([]);
  });

  it("labels a one-to-one relationship 1:1", () => {
    expect(cardinalityLabel("one-to-one")).toBe("1:1");
    const profile = node("user_profiles", ["user_id", "bio"]);
    const rel = fk(
      "user_profiles_user_id_fkey",
      ["user_profiles", ["user_id"]],
      ["users", ["id"]],
      {
        cardinality: "one-to-one",
      },
    );
    expect(buildEdges([rel], [profile, users])[0]?.label).toBe("1:1");
  });

  it("uses the first column of a composite foreign key", () => {
    const addresses = node("addresses", ["id", "country_code", "region_code"]);
    const regions = node("regions", ["country_code", "region_code"]);
    const rel = fk(
      "addresses_region_fkey",
      ["addresses", ["country_code", "region_code"]],
      ["regions", ["country_code", "region_code"]],
    );
    expect(buildEdges([rel], [addresses, regions])[0]).toMatchObject({
      sourceHandle: columnHandleId("source", "country_code"),
      targetHandle: columnHandleId("target", "country_code"),
    });
  });

  it("falls back to the table header when the key column is hidden by collapsing", () => {
    const wide = node("wide", [
      ...Array.from({ length: COLLAPSED_COLUMN_LIMIT + 5 }, (_v, i) => `c${i}`),
      "user_id",
    ]);
    const rel = fk("wide_user_fkey", ["wide", ["user_id"]], ["users", ["id"]]);

    expect(buildEdges([rel], [wide, users])[0]?.sourceHandle).toBe(tableHandleId("source"));
    // Expanding the table reveals the column, and the edge moves to its row.
    expect(buildEdges([rel], [{ ...wide, expanded: true }, users])[0]?.sourceHandle).toBe(
      columnHandleId("source", "user_id"),
    );
  });

  it("supports a table that references itself", () => {
    const employees = node("employees", ["id", "manager_id"]);
    const rel = fk("employees_manager_fkey", ["employees", ["manager_id"]], ["employees", ["id"]]);
    const [edge] = buildEdges([rel], [employees]);
    expect(edge?.source).toBe(edge?.target);
  });

  it("keeps separate edges for several relationships between the same two tables", () => {
    const messages = node("messages", ["id", "sender_id", "recipient_id"]);
    const rels = [
      fk("messages_sender_fkey", ["messages", ["sender_id"]], ["users", ["id"]]),
      fk("messages_recipient_fkey", ["messages", ["recipient_id"]], ["users", ["id"]]),
    ];
    const edges = buildEdges(rels, [messages, users]);
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((e) => e.id)).size).toBe(2);
  });

  it("gives distinct ids to equally named constraints on different tables", () => {
    const a = node("a", ["x"]);
    const b = node("b", ["x"]);
    const rels = [
      fk("same_fkey", ["a", ["x"]], ["users", ["id"]]),
      fk("same_fkey", ["b", ["x"]], ["users", ["id"]]),
    ];
    const edges = buildEdges(rels, [a, b, users]);
    expect(new Set(edges.map((e) => e.id)).size).toBe(2);
  });

  it("tells apart tables with the same name in different schemas", () => {
    const audit = node("users", ["id"], false, "audit");
    expect(buildEdges([ordersToUsers], [orders, audit])).toEqual([]); // public.users is not on the canvas
  });
});
