import type { WorkspaceInput } from "@datacanvas/shared-types";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_WORKSPACES, exportFileName } from "./workspace-service";
import { createTestContext } from "./test-support";

const input = (overrides: Partial<WorkspaceInput> = {}): WorkspaceInput => ({
  name: "Orders layout",
  profileId: null,
  connectionHint: { connectionName: "Shop", database: "shop" },
  canvas: {
    nodes: [{ schema: "public", name: "orders", x: 10, y: 20, expanded: true }],
    viewport: { x: 1, y: 2, zoom: 0.5 },
  },
  ...overrides,
});

/** A clock the test moves forward by hand. */
function clock(start = "2026-11-13T10:00:00.000Z") {
  let current = new Date(start).getTime();
  return { now: () => new Date(current), advance: (ms: number) => void (current += ms) };
}

describe("WorkspaceService.save", () => {
  it("creates a workspace; the server owns the id and the timestamps", async () => {
    const time = clock();
    const { workspaces } = createTestContext({}, { now: time.now });

    const saved = await workspaces.save("ws-aaaaaaaa", input());

    expect(saved).toMatchObject({
      format: "datacanvas-workspace",
      schemaVersion: 1,
      id: "ws-aaaaaaaa",
      createdAt: "2026-11-13T10:00:00.000Z",
      updatedAt: "2026-11-13T10:00:00.000Z",
    });
    expect(await workspaces.get("ws-aaaaaaaa")).toEqual(saved);
  });

  it("keeps createdAt and moves updatedAt forward on update", async () => {
    const time = clock();
    const { workspaces } = createTestContext({}, { now: time.now });
    await workspaces.save("ws-aaaaaaaa", input());
    time.advance(60_000);

    const updated = await workspaces.save("ws-aaaaaaaa", input({ name: "Renamed" }));

    expect(updated.name).toBe("Renamed");
    expect(updated.createdAt).toBe("2026-11-13T10:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-11-13T10:01:00.000Z");
  });

  it("requires the saved connection it points at to exist", async () => {
    const { workspaces } = createTestContext();
    await expect(
      workspaces.save("ws-aaaaaaaa", input({ profileId: "profile-missing1" })),
    ).rejects.toMatchObject({
      code: "profile_not_found",
    });
  });

  it("repairs a damaged file when the same id is saved again", async () => {
    const { workspaces, dataDir } = createTestContext();
    await fs.mkdir(path.join(dataDir, "workspaces"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "workspaces", "ws-aaaaaaaa.json"), "{");
    await workspaces.save("ws-aaaaaaaa", input());
    expect((await workspaces.get("ws-aaaaaaaa")).name).toBe("Orders layout");
  });

  it("stops creating new workspaces at the limit, but still updates existing ones", async () => {
    const { workspaces, dataDir } = createTestContext();
    await fs.mkdir(path.join(dataDir, "workspaces"), { recursive: true });
    const template = JSON.stringify(await workspaces.save("ws-template1", input()));
    for (let i = 0; i < MAX_WORKSPACES - 1; i += 1) {
      const id = `ws-fill${String(i).padStart(5, "0")}`;
      await fs.writeFile(
        path.join(dataDir, "workspaces", `${id}.json`),
        template.replace("ws-template1", id),
      );
    }

    await expect(workspaces.save("ws-onetoomany", input())).rejects.toMatchObject({
      code: "workspace_limit_reached",
    });
    await expect(
      workspaces.save("ws-template1", input({ name: "Still fine" })),
    ).resolves.toMatchObject({ name: "Still fine" });
  });
});

describe("WorkspaceService.list / get / remove", () => {
  it("lists most recently changed first, and can filter by saved connection", async () => {
    const time = clock();
    const { workspaces, profiles } = createTestContext({}, { now: time.now });
    const shop = await profiles.add({
      provider: "postgresql",
      name: "Shop",
      host: "h",
      port: 5432,
      database: "shop",
      username: "u",
      sslMode: "disable",
      dataAccess: false,
    });

    await workspaces.save("ws-oldoldol", input({ name: "Old", profileId: shop.id }));
    time.advance(1000);
    await workspaces.save("ws-newnewne", input({ name: "New", profileId: shop.id }));
    time.advance(1000);
    await workspaces.save("ws-unrelate", input({ name: "Unrelated", profileId: null }));

    expect((await workspaces.list()).map((w) => w.name)).toEqual(["Unrelated", "New", "Old"]);
    expect((await workspaces.list(shop.id)).map((w) => w.name)).toEqual(["New", "Old"]);
    expect((await workspaces.list(shop.id))[0]).toMatchObject({
      tableCount: 1,
      profileId: shop.id,
    });
  });

  it("reports workspace_not_found for get and remove", async () => {
    const { workspaces } = createTestContext();
    await expect(workspaces.get("ws-nothere1")).rejects.toMatchObject({
      code: "workspace_not_found",
    });
    await expect(workspaces.remove("ws-nothere1")).rejects.toMatchObject({
      code: "workspace_not_found",
    });
  });

  it("deletes a workspace", async () => {
    const { workspaces } = createTestContext();
    await workspaces.save("ws-aaaaaaaa", input());
    await workspaces.remove("ws-aaaaaaaa");
    expect(await workspaces.list()).toEqual([]);
  });
});

describe("export and import", () => {
  it("exports a file without the machine-specific profile id, with a safe file name", async () => {
    const { workspaces, profiles } = createTestContext();
    const profile = await profiles.add({
      provider: "postgresql",
      name: "Shop",
      host: "h",
      port: 5432,
      database: "shop",
      username: "u",
      sslMode: "disable",
      dataAccess: false,
    });
    await workspaces.save(
      "ws-aaaaaaaa",
      input({ name: 'Q4 "review"/plan', profileId: profile.id }),
    );

    const { fileName, content } = await workspaces.exportFile("ws-aaaaaaaa");

    expect(fileName).toBe("Q4 _review__plan.datacanvas.json");
    expect(content.profileId).toBeNull();
    expect(content.connectionHint).toEqual({ connectionName: "Shop", database: "shop" });
  });

  it("imports as a NEW workspace attached to the chosen connection, never overwriting", async () => {
    const { workspaces, profiles } = createTestContext();
    const profile = await profiles.add({
      provider: "postgresql",
      name: "Mine",
      host: "h",
      port: 5432,
      database: "shop",
      username: "u",
      sslMode: "disable",
      dataAccess: false,
    });
    await workspaces.save("ws-aaaaaaaa", input());
    const { content } = await workspaces.exportFile("ws-aaaaaaaa");

    const imported = await workspaces.importFile(JSON.parse(JSON.stringify(content)), profile.id);

    expect(imported.id).not.toBe("ws-aaaaaaaa");
    expect(imported.profileId).toBe(profile.id);
    expect(imported.canvas).toEqual(content.canvas);
    expect(await workspaces.list()).toHaveLength(2);
  });

  it("rejects files that are not valid workspaces, with a readable message and no echo", async () => {
    const { workspaces } = createTestContext();
    for (const bad of [
      "text",
      null,
      { format: "other" },
      { format: "datacanvas-workspace", schemaVersion: 99 },
    ]) {
      await expect(workspaces.importFile(bad, null)).rejects.toMatchObject({
        code: "invalid_workspace_file",
      });
    }
    const error = await workspaces
      .importFile({ format: "datacanvas-workspace", schemaVersion: 1, name: 12345678901 }, null)
      .catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain("12345678901");
  });

  it("rejects an import for a connection that does not exist", async () => {
    const { workspaces } = createTestContext();
    await workspaces.save("ws-aaaaaaaa", input());
    const { content } = await workspaces.exportFile("ws-aaaaaaaa");
    await expect(workspaces.importFile(content, "profile-missing1")).rejects.toMatchObject({
      code: "profile_not_found",
    });
  });
});

describe("exportFileName", () => {
  it.each([
    ["Orders layout", "Orders layout.datacanvas.json"],
    ["../../etc/passwd", ".._.._etc_passwd.datacanvas.json"],
    ['a"b\r\nc', "a_b__c.datacanvas.json"],
    ["日本語", "___.datacanvas.json"],
    ["   ", "workspace.datacanvas.json"],
    ["x".repeat(200), `${"x".repeat(60)}.datacanvas.json`],
  ])("turns %j into a header-safe file name", (name, expected) => {
    expect(exportFileName(name)).toBe(expected);
    expect(exportFileName(name)).toMatch(/^[\x20-\x7e]+$/); // printable ASCII only, so it cannot break a header
  });
});
