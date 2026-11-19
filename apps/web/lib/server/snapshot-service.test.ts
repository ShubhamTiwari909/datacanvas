import {
  MAX_SNAPSHOTS,
  MAX_SNAPSHOT_OBJECTS_PER_KIND,
  type PostgresConnectionInput,
} from "@datacanvas/shared-types";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultSnapshotName, snapshotFileName } from "./snapshot-service";
import { createTestContext, fieldsInput } from "./test-support";

const NOW = () => new Date("2026-11-14T10:30:45.000Z");

async function setup() {
  const context = createTestContext({}, { now: NOW });
  const connection = await context.connections.createConnection(
    fieldsInput() as unknown as PostgresConnectionInput,
  );
  return { ...context, connectionId: connection.id };
}

describe("snapshot names", () => {
  it("defaults to the database and the time", () => {
    expect(defaultSnapshotName("shop", NOW())).toBe("shop 2026-11-14 10:30");
  });

  it("makes a safe file name from any snapshot name", () => {
    expect(snapshotFileName('before/after: "v2"\n')).toBe("before_after_ _v2__.snapshot.json");
    expect(snapshotFileName("   ")).toBe("snapshot.snapshot.json");
    expect(snapshotFileName("x".repeat(500)).length).toBeLessThan(80);
  });
});

describe("SnapshotService", () => {
  it("captures the structure on the server and lists a summary without it", async () => {
    const { snapshots, connectionId } = await setup();

    const summary = await snapshots.create(connectionId, {});

    expect(summary.name).toBe("shop 2026-11-14 10:30");
    expect(summary.source).toEqual({ connectionName: "Shop", database: "shop" });
    expect(summary.counts.tables).toBeGreaterThan(0);
    expect(summary.counts.relationships).toBeGreaterThan(0);
    expect(await snapshots.list()).toEqual([summary]);
    expect(JSON.stringify(summary)).not.toContain("columns");
  });

  it("stores the structure and never a password, host or user", async () => {
    const { snapshots, connectionId, dataDir } = await setup();
    const { id } = await snapshots.create(connectionId, { name: "Baseline" });

    const snapshot = await snapshots.get(id);
    expect(snapshot.name).toBe("Baseline");
    expect(snapshot.structure.tables.length).toBeGreaterThan(0);

    const raw = await fs.readFile(path.join(dataDir, "snapshots", `${id}.json`), "utf8");
    for (const secret of ["s3cret-pw", "alice", "localhost"]) {
      expect(raw).not.toContain(secret);
    }
    // Row estimates change with every vacuum: they must not be part of a snapshot.
    expect(raw).not.toContain("estimatedRowCount");
  });

  it("records views, types, sequences, functions, triggers, extensions and policies", async () => {
    const { snapshots, connectionId } = await setup();
    const { id, counts } = await snapshots.create(connectionId, {});
    const { structure } = await snapshots.get(id);

    expect(structure.objects).not.toBeNull();
    expect(structure.objects!.views.map((v) => v.name)).toEqual(["daily_sales", "active_users"]);
    expect(structure.objects!.functions[0]).toMatchObject({ name: "touch_updated_at" });
    expect(counts.objects).toBeGreaterThan(5);
  });

  it("refuses a database with more objects of one kind than a snapshot holds", async () => {
    const { snapshots, connectionId, createdAdapters } = await setup();
    const adapter = createdAdapters[0]!;
    const real = await adapter.getObjects();
    const extension = real.extensions[0]!;
    adapter.getObjects = async () => ({
      ...real,
      extensions: Array.from({ length: MAX_SNAPSHOT_OBJECTS_PER_KIND + 1 }, (_, i) => ({
        ...extension,
        name: `ext${i}`,
      })),
    });

    await expect(snapshots.create(connectionId, {})).rejects.toMatchObject({
      code: "snapshot_too_large",
    });
    expect(await snapshots.list()).toEqual([]);
  });

  it("opens a snapshot saved by the previous release (no objects) and marks them not recorded", async () => {
    const { snapshots, connectionId, dataDir } = await setup();
    const { id } = await snapshots.create(connectionId, { name: "old" });
    const file = path.join(dataDir, "snapshots", `${id}.json`);
    const written = JSON.parse(await fs.readFile(file, "utf8"));
    delete written.structure.objects;
    delete written.structure.ddl;
    written.schemaVersion = 1;
    await fs.writeFile(file, JSON.stringify(written));

    const loaded = await snapshots.get(id);
    expect(loaded.schemaVersion).toBe(3);
    expect(loaded.structure.objects).toBeNull();
    expect((await snapshots.list())[0]!.counts.objects).toBeNull();
  });

  it("never reads a row: taking, loading, exporting or importing a snapshot does not call getRows", async () => {
    const { snapshots, connections, connectionId, createdAdapters } = await setup();
    const spy = vi.spyOn(createdAdapters[0]!, "getRows");

    const { id } = await snapshots.create(connectionId, { name: "no rows" });
    await snapshots.get(id);
    const { content } = await snapshots.exportFile(id);
    await snapshots.importFile(JSON.parse(JSON.stringify(content)));
    await connections.captureStructure(connectionId);
    await connections.getObjects(connectionId);
    await connections.getIndexUsage(connectionId);

    expect(spy).not.toHaveBeenCalled();
  });

  it("lists newest first", async () => {
    let at = new Date("2026-11-14T10:00:00.000Z").getTime();
    const context = createTestContext({}, { now: () => new Date((at += 60_000)) });
    const connection = await context.connections.createConnection(
      fieldsInput() as unknown as PostgresConnectionInput,
    );
    await context.snapshots.create(connection.id, { name: "first" });
    await context.snapshots.create(connection.id, { name: "second" });

    expect((await context.snapshots.list()).map((s) => s.name)).toEqual(["second", "first"]);
  });

  it("answers snapshot_not_found for an unknown or malformed id", async () => {
    const { snapshots } = await setup();
    await expect(snapshots.get("nope-nope-nope")).rejects.toMatchObject({
      code: "snapshot_not_found",
    });
    await expect(snapshots.get("../../etc/passwd")).rejects.toMatchObject({
      code: "snapshot_not_found",
    });
    await expect(snapshots.remove("missing-id-123")).rejects.toMatchObject({
      code: "snapshot_not_found",
    });
  });

  it("answers connection_not_found for an unknown connection", async () => {
    const { snapshots } = await setup();
    await expect(snapshots.create("missing", {})).rejects.toMatchObject({
      code: "connection_not_found",
    });
  });

  it("removes a snapshot", async () => {
    const { snapshots, connectionId } = await setup();
    const { id } = await snapshots.create(connectionId, {});
    await snapshots.remove(id);
    expect(await snapshots.list()).toEqual([]);
  });

  it("refuses to take or import more than the maximum", async () => {
    const { snapshots, connectionId } = await setup();
    const first = await snapshots.create(connectionId, { name: "s0" });
    const { content } = await snapshots.exportFile(first.id);
    for (let i = 1; i < MAX_SNAPSHOTS; i++) {
      await snapshots.create(connectionId, { name: `s${i}` });
    }
    await expect(snapshots.create(connectionId, {})).rejects.toMatchObject({
      code: "snapshot_limit_reached",
    });
    await expect(snapshots.importFile(content)).rejects.toMatchObject({
      code: "snapshot_limit_reached",
    });
    expect(await snapshots.list()).toHaveLength(MAX_SNAPSHOTS);
  }, 30_000);

  describe("the limit under concurrent requests", () => {
    it("never goes over the maximum when many saves arrive at once", async () => {
      const { snapshots, connectionId } = await setup();
      for (let i = 0; i < MAX_SNAPSHOTS - 2; i++) {
        await snapshots.create(connectionId, { name: `s${i}` });
      }

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => snapshots.create(connectionId, { name: `race${i}` })),
      );

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      for (const failed of results.filter((r) => r.status === "rejected")) {
        expect((failed as PromiseRejectedResult).reason).toMatchObject({
          code: "snapshot_limit_reached",
        });
      }
      expect(await snapshots.list()).toHaveLength(MAX_SNAPSHOTS);
    }, 30_000);

    it("holds for imports too, and for a mix of saves and imports", async () => {
      const { snapshots, connectionId } = await setup();
      const first = await snapshots.create(connectionId, { name: "first" });
      const { content } = await snapshots.exportFile(first.id);
      for (let i = 1; i < MAX_SNAPSHOTS - 1; i++) {
        await snapshots.create(connectionId, { name: `s${i}` });
      }

      const results = await Promise.allSettled([
        snapshots.importFile(JSON.parse(JSON.stringify(content))),
        snapshots.create(connectionId, { name: "a" }),
        snapshots.importFile(JSON.parse(JSON.stringify(content))),
        snapshots.create(connectionId, { name: "b" }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await snapshots.list()).toHaveLength(MAX_SNAPSHOTS);
    }, 30_000);
  });

  describe("export and import", () => {
    it("round-trips: an imported file is a new snapshot with the same structure", async () => {
      const { snapshots, connectionId } = await setup();
      const original = await snapshots.create(connectionId, { name: "Baseline" });
      const { fileName, content } = await snapshots.exportFile(original.id);
      expect(fileName).toBe("Baseline.snapshot.json");

      const imported = await snapshots.importFile(JSON.parse(JSON.stringify(content)));

      expect(imported.id).not.toBe(original.id);
      expect(imported.counts).toEqual(original.counts);
      expect((await snapshots.get(imported.id)).structure).toEqual(content.structure);
      expect(await snapshots.list()).toHaveLength(2);
    });

    it.each([
      ["not an object", 42],
      ["another file format", { format: "datacanvas-workspace", schemaVersion: 1 }],
      ["a damaged snapshot", { format: "datacanvas-snapshot", schemaVersion: 1, id: "x" }],
    ])("refuses %s without echoing it", async (_label, raw) => {
      const { snapshots } = await setup();
      await expect(snapshots.importFile(raw)).rejects.toMatchObject({
        code: "invalid_snapshot_file",
      });
      expect(await snapshots.list()).toEqual([]);
    });

    it("refuses an unknown extra key (a hand-edited or hostile file)", async () => {
      const { snapshots, connectionId } = await setup();
      const { id } = await snapshots.create(connectionId, {});
      const { content } = await snapshots.exportFile(id);
      await expect(snapshots.importFile({ ...content, password: "hunter2" })).rejects.toMatchObject(
        { code: "invalid_snapshot_file" },
      );
    });
  });
});
