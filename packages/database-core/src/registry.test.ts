import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "./registry.js";
import { MockDatabaseAdapter } from "./testing/index.js";

interface TestConfigs {
  postgresql: { host: string };
  other: { path: string };
}

describe("AdapterRegistry", () => {
  it("creates an adapter from the registered factory, passing the config through", () => {
    const registry = new AdapterRegistry<TestConfigs>();
    const received: Array<{ host: string }> = [];
    registry.register("postgresql", (config) => {
      received.push(config);
      return new MockDatabaseAdapter();
    });

    const adapter = registry.create("postgresql", { host: "db.example.com" });

    expect(adapter).toBeInstanceOf(MockDatabaseAdapter);
    expect(received).toEqual([{ host: "db.example.com" }]);
  });

  it("does not connect the adapter it creates", async () => {
    const registry = new AdapterRegistry<TestConfigs>();
    registry.register("postgresql", () => new MockDatabaseAdapter());
    const adapter = registry.create("postgresql", { host: "h" });
    await expect(adapter.getSchemas()).rejects.toMatchObject({ code: "not_connected" });
  });

  it("reports which providers are registered", () => {
    const registry = new AdapterRegistry<TestConfigs>();
    expect(registry.has("postgresql")).toBe(false);
    registry.register("postgresql", () => new MockDatabaseAdapter());
    expect(registry.has("postgresql")).toBe(true);
    expect(registry.has("other")).toBe(false);
    expect(registry.providers()).toEqual(["postgresql"]);
  });

  it("refuses to register the same provider twice", () => {
    const registry = new AdapterRegistry<TestConfigs>();
    registry.register("postgresql", () => new MockDatabaseAdapter());
    expect(() => registry.register("postgresql", () => new MockDatabaseAdapter())).toThrow(
      /already registered/,
    );
  });

  it("throws a clear error for a provider that was never registered", () => {
    const registry = new AdapterRegistry<TestConfigs>();
    expect(() => registry.create("other", { path: "/x" })).toThrow(/No database provider/);
  });

  it("is not fooled by names that exist on every JavaScript object", () => {
    const registry = new AdapterRegistry<Record<string, unknown>>();
    expect(registry.has("constructor")).toBe(false);
    expect(() => registry.create("__proto__", {})).toThrow(/No database provider/);
  });
});
