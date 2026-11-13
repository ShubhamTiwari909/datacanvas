import type { ConnectionProfile } from "@datacanvas/shared-types";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDataDir } from "../test-support";
import { ProfileStorage } from "./profile-storage";

const profile = (id: string, overrides: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id,
  provider: "postgresql",
  name: `Profile ${id}`,
  host: "localhost",
  port: 5432,
  database: "shop",
  username: "alice",
  sslMode: "disable",
  createdAt: "2026-11-13T10:00:00.000Z",
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe("ProfileStorage", () => {
  it("is empty before anything is saved, and creates no files by merely listing", async () => {
    const dir = createTestDataDir();
    expect(await new ProfileStorage(dir).list()).toEqual([]);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("saves profiles and reads them back (also from a new instance, as after a restart)", async () => {
    const dir = createTestDataDir();
    await new ProfileStorage(dir).add(profile("profile-aaaaaaaa"));
    await new ProfileStorage(dir).add(profile("profile-bbbbbbbb"));

    const reloaded = await new ProfileStorage(dir).list();
    expect(reloaded.map((p) => p.id)).toEqual(["profile-aaaaaaaa", "profile-bbbbbbbb"]);
  });

  it("writes a versioned file that contains no password", async () => {
    const dir = createTestDataDir();
    await new ProfileStorage(dir).add(profile("profile-aaaaaaaa"));
    const text = await fs.readFile(path.join(dir, "connections.json"), "utf8");
    expect(JSON.parse(text)).toMatchObject({ format: "datacanvas-connections", schemaVersion: 1 });
    expect(text.toLowerCase()).not.toContain("password");
  });

  it("removes a profile, and reports whether it existed", async () => {
    const storage = new ProfileStorage(createTestDataDir());
    await storage.add(profile("profile-aaaaaaaa"));
    expect(await storage.remove("profile-aaaaaaaa")).toBe(true);
    expect(await storage.remove("profile-aaaaaaaa")).toBe(false);
    expect(await storage.list()).toEqual([]);
  });

  it("does not lose profiles when several are added at the same moment", async () => {
    const storage = new ProfileStorage(createTestDataDir());
    await Promise.all(
      Array.from({ length: 20 }, (_v, i) =>
        storage.add(profile(`profile-${String(i).padStart(8, "0")}`)),
      ),
    );
    expect(await storage.list()).toHaveLength(20);
  });

  it("moves a damaged file aside instead of deleting it, and starts fresh", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = createTestDataDir();
    await fs.writeFile(path.join(dir, "connections.json"), "{ this is not json");

    const storage = new ProfileStorage(dir);
    expect(await storage.list()).toEqual([]);

    const names = await fs.readdir(dir);
    const aside = names.find((n) => n.startsWith("connections.damaged-"));
    expect(aside).toBeDefined();
    expect(await fs.readFile(path.join(dir, aside as string), "utf8")).toBe("{ this is not json");

    await storage.add(profile("profile-aaaaaaaa")); // usable again
    expect(await storage.list()).toHaveLength(1);
  });

  it("refuses to touch a file written by a NEWER release", async () => {
    const dir = createTestDataDir();
    const newer = JSON.stringify({
      format: "datacanvas-connections",
      schemaVersion: 99,
      profiles: [],
    });
    await fs.writeFile(path.join(dir, "connections.json"), newer);

    await expect(new ProfileStorage(dir).list()).rejects.toMatchObject({ code: "storage_error" });
    expect(await fs.readFile(path.join(dir, "connections.json"), "utf8")).toBe(newer); // untouched
  });

  it("reports an unusable data folder as a safe storage_error", async () => {
    const dir = createTestDataDir();
    const blocker = path.join(dir, "file-not-folder");
    await fs.writeFile(blocker, "x");
    const error = await new ProfileStorage(path.join(blocker, "inside"))
      .add(profile("profile-aaaaaaaa"))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "storage_error" });
    expect(String((error as Error).message)).not.toContain(blocker); // no paths in messages
  });
});
