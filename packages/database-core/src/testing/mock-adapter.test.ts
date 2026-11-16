import { beforeEach, describe, expect, it } from "vitest";
import { describeAdapterContract } from "./contract.js";
import { createEcommerceData, MockDatabaseAdapter } from "./index.js";

// The mock must satisfy exactly the same behavioural contract as the real adapters.
describeAdapterContract("MockDatabaseAdapter", () => new MockDatabaseAdapter());

// Everything below is specific to the mock itself.
describe("MockDatabaseAdapter specifics", () => {
  let adapter: MockDatabaseAdapter;

  beforeEach(async () => {
    adapter = new MockDatabaseAdapter();
    await adapter.connect();
  });

  it("can be told to fail like a real database would", async () => {
    const failing = new MockDatabaseAdapter({ failConnectWith: "authentication_failed" });
    await expect(failing.connect()).rejects.toMatchObject({ code: "authentication_failed" });
    await expect(failing.testConnection()).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("is not fooled by names that exist on every JavaScript object", async () => {
    await expect(adapter.getColumns("public", "constructor")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("returns copies: changing a result does not change the database", async () => {
    const first = await adapter.getTables("public");
    first[0]!.name = "tampered";
    const second = await adapter.getTables("public");
    expect(second[0]!.name).toBe("active_users");
  });

  it("reports row-level security for the tables that have it switched on", async () => {
    const options = { pageSize: 50, cursor: null, revealColumns: [] };
    // The sample data switches it on for orders and not for users.
    expect((await adapter.getRows({ schema: "public", name: "orders" }, options)).rowSecurity).toBe(
      "applies",
    );
    expect((await adapter.getRows({ schema: "public", name: "users" }, options)).rowSecurity).toBe(
      "off",
    );
  });

  describe("objects and index usage", () => {
    it("need a connection, like every other data call", async () => {
      const idle = new MockDatabaseAdapter();
      await expect(idle.getObjects()).rejects.toMatchObject({ code: "not_connected" });
      await expect(idle.getIndexUsage()).rejects.toMatchObject({ code: "not_connected" });
    });

    it("return copies: changing a result does not change the database", async () => {
      const objects = await adapter.getObjects();
      objects.views.length = 0;
      expect((await adapter.getObjects()).views.length).toBeGreaterThan(0);
      const usage = await adapter.getIndexUsage();
      usage.indexes.length = 0;
      expect((await adapter.getIndexUsage()).indexes.length).toBeGreaterThan(0);
    });

    it("give objects in their sorted normal form", async () => {
      const { views } = await adapter.getObjects();
      expect(views.map((v) => `${v.schema}.${v.name}`)).toEqual(
        [...views.map((v) => `${v.schema}.${v.name}`)].sort(),
      );
    });
  });

  describe("sample data integrity", () => {
    it("is JSON-safe: a round trip through JSON changes nothing", () => {
      const data = createEcommerceData();
      expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    });

    it("every table has an entry for columns, constraints and indexes", () => {
      const data = createEcommerceData();
      for (const t of data.tables) {
        const key = `${t.schema}.${t.name}`;
        expect(data.columns[key]).toBeDefined();
        expect(data.constraints[key]).toBeDefined();
        expect(data.indexes[key]).toBeDefined();
      }
    });
  });
});
