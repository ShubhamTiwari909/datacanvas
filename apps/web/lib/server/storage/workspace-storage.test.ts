import type { Workspace } from "@datacanvas/shared-types";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDataDir } from "../test-support";
import { WorkspaceStorage } from "./workspace-storage";

const workspace = (id: string, overrides: Partial<Workspace> = {}): Workspace => ({
  format: "datacanvas-workspace",
  schemaVersion: 1,
  id,
  name: `Workspace ${id}`,
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
  profileId: null,
  connectionHint: null,
  canvas: {
    nodes: [{ schema: "public", name: "users", x: 1, y: 2, expanded: false }],
    viewport: null,
  },
  ...overrides,
});

describe("WorkspaceStorage", () => {
  it("returns nothing from an empty or missing folder", async () => {
    const storage = new WorkspaceStorage(createTestDataDir());
    expect(await storage.list()).toEqual({ workspaces: [], skipped: 0 });
    expect(await storage.get("ws-aaaaaaaa")).toBeNull();
  });

  it("saves, reads back and deletes a workspace, one JSON file per id", async () => {
    const dir = createTestDataDir();
    const storage = new WorkspaceStorage(dir);
    await storage.put(workspace("ws-aaaaaaaa"));

    expect(await fs.readdir(path.join(dir, "workspaces"))).toEqual(["ws-aaaaaaaa.json"]);
    expect(await storage.get("ws-aaaaaaaa")).toEqual(workspace("ws-aaaaaaaa"));

    expect(await storage.remove("ws-aaaaaaaa")).toBe(true);
    expect(await storage.remove("ws-aaaaaaaa")).toBe(false);
    expect(await storage.get("ws-aaaaaaaa")).toBeNull();
  });

  it("survives a restart: a new instance on the same folder sees the same data", async () => {
    const dir = createTestDataDir();
    await new WorkspaceStorage(dir).put(workspace("ws-aaaaaaaa"));
    expect((await new WorkspaceStorage(dir).list()).workspaces.map((w) => w.id)).toEqual([
      "ws-aaaaaaaa",
    ]);
  });

  it("overwrites on update", async () => {
    const storage = new WorkspaceStorage(createTestDataDir());
    await storage.put(workspace("ws-aaaaaaaa"));
    await storage.put(workspace("ws-aaaaaaaa", { name: "Renamed" }));
    expect((await storage.get("ws-aaaaaaaa"))?.name).toBe("Renamed");
    expect((await storage.list()).workspaces).toHaveLength(1);
  });

  describe("path safety (an id becomes a file name)", () => {
    const hostile = [
      "../../etc/passwd",
      "..",
      "a/b",
      "a\\b",
      "/etc/passwd",
      "ws.json",
      "",
      "short",
      ".hidden-file-1",
      "x".repeat(65),
      "ws-aaaa\0aaaa",
    ];

    it.each(hostile)("treats %j as not found, never touching the disk", async (id) => {
      const dir = createTestDataDir();
      const storage = new WorkspaceStorage(dir);
      expect(await storage.get(id)).toBeNull();
      expect(await storage.remove(id)).toBe(false);
      await expect(storage.put(workspace(id))).rejects.toMatchObject({
        code: "workspace_not_found",
      });
      expect(await fs.readdir(dir)).toEqual([]); // nothing was created anywhere
    });

    it("cannot write outside the workspaces folder", async () => {
      const dir = createTestDataDir();
      await new WorkspaceStorage(dir).put(workspace("ws-aaaaaaaa"));
      expect((await fs.readdir(dir)).sort()).toEqual(["workspaces"]);
    });
  });

  describe("damaged files", () => {
    it("skips them when listing (and counts them), but leaves them on disk", async () => {
      const dir = createTestDataDir();
      const storage = new WorkspaceStorage(dir);
      await storage.put(workspace("ws-aaaaaaaa"));
      await fs.writeFile(path.join(dir, "workspaces", "ws-bbbbbbbb.json"), "not json at all");
      await fs.writeFile(
        path.join(dir, "workspaces", "ws-cccccccc.json"),
        JSON.stringify({ format: "datacanvas-workspace" }),
      );

      const listed = await storage.list();
      expect(listed.workspaces.map((w) => w.id)).toEqual(["ws-aaaaaaaa"]);
      expect(listed.skipped).toBe(2);
      expect(await fs.readdir(path.join(dir, "workspaces"))).toHaveLength(3);
    });

    it("reports invalid_workspace_file when one is opened directly", async () => {
      const dir = createTestDataDir();
      await fs.mkdir(path.join(dir, "workspaces"), { recursive: true });
      await fs.writeFile(path.join(dir, "workspaces", "ws-bbbbbbbb.json"), "{");
      await expect(new WorkspaceStorage(dir).get("ws-bbbbbbbb")).rejects.toMatchObject({
        code: "invalid_workspace_file",
      });
    });

    it("ignores leftover temporary files from an interrupted write", async () => {
      const dir = createTestDataDir();
      const storage = new WorkspaceStorage(dir);
      await storage.put(workspace("ws-aaaaaaaa"));
      await fs.writeFile(path.join(dir, "workspaces", ".ws-aaaaaaaa.json.abc123.tmp"), "half");
      expect((await storage.list()).skipped).toBe(0);
    });
  });
});
