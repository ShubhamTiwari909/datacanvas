import { emptyObjects, type DatabaseObjects, type ViewInfo } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { filterObjects, policyGroups, readersOf, viewReaders } from "./object-lists";

const view = (name: string, dependsOn: string[], schema = "public"): ViewInfo => ({
  schema,
  name,
  materialized: false,
  comment: null,
  definition: "SELECT 1",
  dependsOn: dependsOn.map((d) => ({ schema: "public", name: d })),
});

describe("filterObjects", () => {
  const views = [view("active_users", []), view("Daily_Sales", [], "analytics")];

  it("matches the display name, ignoring case", () => {
    expect(filterObjects("views", views, "SALES").map((v) => v.name)).toEqual(["Daily_Sales"]);
    expect(filterObjects("views", views, "analytics.").map((v) => v.name)).toEqual(["Daily_Sales"]);
  });

  it("keeps everything for a blank query, and nothing for no match", () => {
    expect(filterObjects("views", views, "  ")).toHaveLength(2);
    expect(filterObjects("views", views, "zzz")).toEqual([]);
  });

  it("treats % and _ as ordinary characters", () => {
    expect(filterObjects("views", views, "%")).toEqual([]);
    expect(filterObjects("views", views, "active_")).toHaveLength(1);
  });
});

describe("viewReaders", () => {
  it("lists the views that read each relation", () => {
    const readers = viewReaders([
      view("a", ["users"]),
      view("b", ["users", "a"]),
      view("c", ["orders"]),
    ]);
    expect(readersOf(readers, "public", "users").map((v) => v.name)).toEqual(["a", "b"]);
    expect(readersOf(readers, "public", "a").map((v) => v.name)).toEqual(["b"]);
    expect(readersOf(readers, "public", "nobody")).toEqual([]);
  });

  it("ignores a view that lists itself", () => {
    expect(readersOf(viewReaders([view("a", ["a"])]), "public", "a")).toEqual([]);
  });
});

describe("policyGroups", () => {
  const policy = (table: string, name: string) => ({
    schema: "public",
    table,
    name,
    command: "all" as const,
    permissive: true,
    roles: ["public"],
    using: null,
    withCheck: null,
  });
  const objects = (o: Partial<DatabaseObjects>): DatabaseObjects => ({ ...emptyObjects(), ...o });

  it("groups policies per table with the security switch", () => {
    const groups = policyGroups(
      objects({
        rowSecurity: [{ schema: "public", table: "orders", forced: true }],
        policies: [policy("orders", "p2"), policy("orders", "p1")],
      }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      table: "orders",
      enabled: true,
      forced: true,
      warning: null,
    });
    expect(groups[0]!.policies).toHaveLength(2);
  });

  it("warns when security is on but nothing allows any row", () => {
    const [group] = policyGroups(
      objects({ rowSecurity: [{ schema: "public", table: "secrets", forced: false }] }),
    );
    expect(group).toMatchObject({ enabled: true, policies: [], warning: "no_policies" });
  });

  it("warns when policies exist but security is off, so they do nothing", () => {
    const [group] = policyGroups(objects({ policies: [policy("notes", "p")] }));
    expect(group).toMatchObject({ enabled: false, warning: "inactive" });
  });

  it("is empty for a database without row-level security, and sorted otherwise", () => {
    expect(policyGroups(objects({}))).toEqual([]);
    const groups = policyGroups(objects({ policies: [policy("b", "p"), policy("a", "p")] }));
    expect(groups.map((g) => g.table)).toEqual(["a", "b"]);
  });
});
