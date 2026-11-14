import type { Snapshot } from "@datacanvas/shared-types";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDataDir } from "../test-support";
import { SnapshotStorage } from "./snapshot-storage";

const snapshot = (id: string, overrides: Partial<Snapshot> = {}): Snapshot => ({
  format: "datacanvas-snapshot",
  schemaVersion: 2,
  id,
  name: `Snapshot ${id}`,
  createdAt: "2026-11-14T10:00:00.000Z",
  source: { connectionName: "Shop", database: "shop" },
  structure: { schemas: ["public"], tables: [], relationships: [], objects: null },
  ...overrides,
});

describe("SnapshotStorage", () => {
  it("returns nothing from an empty or missing folder", async () => {
    const storage = new SnapshotStorage(createTestDataDir());
    expect(await storage.list()).toEqual({ snapshots: [], skipped: 0 });
    expect(await storage.get("snap-aaaaaaaa")).toBeNull();
  });

  it("saves, reads back and deletes a snapshot, one JSON file per id", async () => {
    const dir = createTestDataDir();
    const storage = new SnapshotStorage(dir);
    await storage.put(snapshot("snap-aaaaaaaa"));

    expect(await fs.readdir(path.join(dir, "snapshots"))).toEqual(["snap-aaaaaaaa.json"]);
    expect(await storage.get("snap-aaaaaaaa")).toEqual(snapshot("snap-aaaaaaaa"));
    expect(await storage.remove("snap-aaaaaaaa")).toBe(true);
    expect(await storage.remove("snap-aaaaaaaa")).toBe(false);
    expect(await storage.get("snap-aaaaaaaa")).toBeNull();
  });

  it("survives a restart: a new instance on the same folder sees the same data", async () => {
    const dir = createTestDataDir();
    await new SnapshotStorage(dir).put(snapshot("snap-aaaaaaaa"));
    expect((await new SnapshotStorage(dir).list()).snapshots.map((s) => s.id)).toEqual([
      "snap-aaaaaaaa",
    ]);
  });

  it("lists the good snapshots, counts a damaged file as skipped, and leaves it on disk", async () => {
    const dir = createTestDataDir();
    const storage = new SnapshotStorage(dir);
    await storage.put(snapshot("snap-aaaaaaaa"));
    const folder = path.join(dir, "snapshots");
    await fs.writeFile(path.join(folder, "snap-damaged1.json"), "{ not json");
    await fs.writeFile(path.join(folder, "snap-wrongfmt.json"), JSON.stringify({ format: "x" }));

    const listed = await storage.list();

    expect(listed.snapshots.map((s) => s.id)).toEqual(["snap-aaaaaaaa"]);
    expect(listed.skipped).toBe(2);
    // Nothing is deleted: the user may want to repair or inspect the file.
    expect((await fs.readdir(folder)).sort()).toEqual([
      "snap-aaaaaaaa.json",
      "snap-damaged1.json",
      "snap-wrongfmt.json",
    ]);
    expect(await fs.readFile(path.join(folder, "snap-damaged1.json"), "utf8")).toBe("{ not json");
  });

  it("refuses to open a damaged snapshot, with a fixed message that does not echo the file", async () => {
    const dir = createTestDataDir();
    const storage = new SnapshotStorage(dir);
    await storage.put(snapshot("snap-aaaaaaaa"));
    await fs.writeFile(
      path.join(dir, "snapshots", "snap-damaged1.json"),
      JSON.stringify({ secret: "do-not-echo" }),
    );

    const error = await storage.get("snap-damaged1").catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "invalid_snapshot_file" });
    expect(String((error as Error).message)).not.toContain("do-not-echo");
  });

  it("ignores temporary files left by an interrupted write", async () => {
    const dir = createTestDataDir();
    const storage = new SnapshotStorage(dir);
    await storage.put(snapshot("snap-aaaaaaaa"));
    await fs.writeFile(path.join(dir, "snapshots", ".snap-aaaaaaaa.json.tmp123"), "partial");
    await fs.writeFile(path.join(dir, "snapshots", ".hidden.json"), "partial");

    expect(await storage.list()).toMatchObject({ skipped: 0 });
    expect((await storage.list()).snapshots).toHaveLength(1);
  });

  it("opens a file written by the previous release (version 1, no objects)", async () => {
    const dir = createTestDataDir();
    const storage = new SnapshotStorage(dir);
    await storage.put(snapshot("snap-aaaaaaaa"));
    const file = path.join(dir, "snapshots", "snap-aaaaaaaa.json");
    const old = JSON.parse(await fs.readFile(file, "utf8"));
    delete old.structure.objects;
    old.schemaVersion = 1;
    await fs.writeFile(file, JSON.stringify(old));

    const opened = await storage.get("snap-aaaaaaaa");
    expect(opened?.schemaVersion).toBe(2);
    expect(opened?.structure.objects).toBeNull();
  });

  it("never turns an id into a path", async () => {
    const dir = createTestDataDir();
    const storage = new SnapshotStorage(dir);
    expect(await storage.get("../../etc/passwd")).toBeNull();
    expect(await storage.remove("../x")).toBe(false);
    await expect(storage.put(snapshot("../escape"))).rejects.toMatchObject({
      code: "snapshot_not_found",
    });
    await expect(fs.readdir(path.join(dir, ".."))).resolves.not.toContain("escape.json");
  });
});
