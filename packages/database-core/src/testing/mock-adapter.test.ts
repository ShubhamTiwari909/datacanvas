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
