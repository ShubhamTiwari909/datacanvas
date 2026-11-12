import { MockDatabaseAdapter } from "@datacanvas/database-core/testing";
import type { ConnectionSummary } from "@datacanvas/shared-types";
import { describe, expect, it } from "vitest";
import { ConnectionRegistry } from "./connection-registry";

const details: Omit<ConnectionSummary, "id"> = {
  provider: "postgresql",
  name: "Shop",
  host: "localhost",
  port: 5432,
  database: "shop",
  username: "alice",
  sslMode: "disable",
  hasPassword: true,
};

/** A registry whose clock the test controls. */
function setup(options: { maxConnections?: number; idleTimeoutMs?: number } = {}) {
  let clock = 1_000_000;
  let counter = 0;
  const registry = new ConnectionRegistry({
    ...options,
    now: () => clock,
    generateId: () => `connection-id-${++counter}`.padEnd(16, "x"),
  });
  return { registry, advance: (ms: number) => void (clock += ms) };
}

describe("ConnectionRegistry", () => {
  it("adds a connection and lists it with a generated id", () => {
    const { registry } = setup();
    const summary = registry.add(details, new MockDatabaseAdapter());
    expect(summary.id).toMatch(/^connection-id-1/);
    expect(registry.list()).toEqual([summary]);
  });

  it("generates unguessable URL-safe ids by default", () => {
    const registry = new ConnectionRegistry({ maxConnections: 100 });
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) ids.add(registry.add(details, new MockDatabaseAdapter()).id);
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("refuses to exceed the connection limit", () => {
    const { registry } = setup({ maxConnections: 2 });
    registry.add(details, new MockDatabaseAdapter());
    registry.add(details, new MockDatabaseAdapter());
    expect(() => registry.add(details, new MockDatabaseAdapter())).toThrow(
      expect.objectContaining({ code: "connection_limit_reached" }),
    );
  });

  it("runs work against the adapter, connecting it first", async () => {
    const { registry } = setup();
    const adapter = new MockDatabaseAdapter(); // NOT connected yet
    const { id } = registry.add(details, adapter);

    const schemas = await registry.use(id, (a) => a.getSchemas());
    expect(schemas.map((s) => s.name)).toEqual(["analytics", "public"]);
  });

  it("rejects an unknown id", async () => {
    const { registry } = setup();
    await expect(registry.use("nope", (a) => a.getSchemas())).rejects.toMatchObject({
      code: "connection_not_found",
    });
    await expect(registry.remove("nope")).rejects.toMatchObject({ code: "connection_not_found" });
  });

  it("remove() forgets the connection and disconnects it", async () => {
    const { registry } = setup();
    const adapter = new MockDatabaseAdapter();
    const { id } = registry.add(details, adapter);
    await registry.use(id, (a) => a.getSchemas());

    await registry.remove(id);

    expect(registry.list()).toEqual([]);
    await expect(adapter.getSchemas()).rejects.toMatchObject({ code: "not_connected" });
    await expect(registry.use(id, (a) => a.getSchemas())).rejects.toMatchObject({
      code: "connection_not_found",
    });
  });

  describe("idle handling", () => {
    it("closes a connection that has been idle too long, but keeps it registered", async () => {
      const { registry, advance } = setup({ idleTimeoutMs: 60_000 });
      const adapter = new MockDatabaseAdapter();
      const { id } = registry.add(details, adapter);
      await registry.use(id, (a) => a.getSchemas());

      advance(59_000);
      expect(await registry.closeIdle()).toBe(0);

      advance(2_000);
      expect(await registry.closeIdle()).toBe(1);
      expect(registry.list()).toHaveLength(1); // credentials are kept
      await expect(adapter.getSchemas()).rejects.toMatchObject({ code: "not_connected" });
    });

    it("reconnects transparently on the next use", async () => {
      const { registry, advance } = setup({ idleTimeoutMs: 60_000 });
      const { id } = registry.add(details, new MockDatabaseAdapter());
      await registry.use(id, (a) => a.getSchemas());
      advance(120_000);
      await registry.closeIdle();

      await expect(registry.use(id, (a) => a.getSchemas())).resolves.toHaveLength(2);
    });

    it("using a connection resets its idle timer", async () => {
      const { registry, advance } = setup({ idleTimeoutMs: 60_000 });
      const { id } = registry.add(details, new MockDatabaseAdapter());
      advance(50_000);
      await registry.use(id, (a) => a.getSchemas());
      advance(50_000);
      expect(await registry.closeIdle()).toBe(0);
    });

    it("never closes a connection while a request is using it", async () => {
      const { registry, advance } = setup({ idleTimeoutMs: 60_000 });
      const adapter = new MockDatabaseAdapter();
      const { id } = registry.add(details, adapter);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow = registry.use(id, async (a) => {
        await gate;
        return a.getSchemas();
      });
      await Promise.resolve(); // let `use` start

      advance(10 * 60_000);
      expect(await registry.closeIdle()).toBe(0);

      release();
      await expect(slow).resolves.toHaveLength(2);
    });

    it("does not close the same idle connection twice", async () => {
      const { registry, advance } = setup({ idleTimeoutMs: 60_000 });
      const { id } = registry.add(details, new MockDatabaseAdapter());
      await registry.use(id, (a) => a.getSchemas());
      advance(120_000);
      expect(await registry.closeIdle()).toBe(1);
      expect(await registry.closeIdle()).toBe(0);
    });
  });

  it("dispose() disconnects everything and forgets all credentials", async () => {
    const { registry } = setup();
    const a = new MockDatabaseAdapter();
    const b = new MockDatabaseAdapter();
    const first = registry.add(details, a);
    registry.add(details, b);
    await registry.use(first.id, (x) => x.getSchemas());

    await registry.dispose();

    expect(registry.list()).toEqual([]);
    await expect(a.getSchemas()).rejects.toMatchObject({ code: "not_connected" });
  });

  it("lists no password", () => {
    const { registry } = setup();
    registry.add(details, new MockDatabaseAdapter());
    expect(JSON.stringify(registry.list())).not.toMatch(/password":"/);
  });
});
