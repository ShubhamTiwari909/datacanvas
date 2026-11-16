import { describe, expect, it } from "vitest";
import { createTestContext } from "./test-support";

const details = {
  provider: "postgresql" as const,
  name: "Shop",
  host: "localhost",
  port: 5432,
  database: "shop",
  username: "alice",
  sslMode: "disable" as const,
  dataAccess: false,
};

describe("ProfileService", () => {
  it("saves a profile with a generated id and timestamp", async () => {
    const { profiles } = createTestContext({}, { now: () => new Date("2026-11-13T10:00:00.000Z") });
    const profile = await profiles.add(details);
    expect(profile).toMatchObject({ ...details, createdAt: "2026-11-13T10:00:00.000Z" });
    expect(profile.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(await profiles.list()).toEqual([profile]);
  });

  it("returns the existing profile instead of saving the same database twice", async () => {
    const { profiles } = createTestContext();
    const first = await profiles.add(details);
    const again = await profiles.add({ ...details, name: "Another name" });
    expect(again.id).toBe(first.id);
    expect(await profiles.list()).toHaveLength(1);
  });

  it("treats a different database, user, host or port as a different profile", async () => {
    const { profiles } = createTestContext();
    await profiles.add(details);
    await profiles.add({ ...details, database: "other" });
    await profiles.add({ ...details, username: "bob" });
    await profiles.add({ ...details, host: "db.example.com" });
    await profiles.add({ ...details, port: 6543 });
    expect(await profiles.list()).toHaveLength(5);
  });

  it("gets a profile, or reports profile_not_found", async () => {
    const { profiles } = createTestContext();
    const saved = await profiles.add(details);
    expect(await profiles.get(saved.id)).toEqual(saved);
    await expect(profiles.get("nope-nope-nope")).rejects.toMatchObject({
      code: "profile_not_found",
    });
  });

  it("forgetting a profile also deletes its workspaces, and only its own", async () => {
    const { profiles, workspaces } = createTestContext();
    const keep = await profiles.add({ ...details, database: "keep" });
    const forget = await profiles.add(details);
    const input = (profileId: string) => ({
      name: "Layout",
      profileId,
      connectionHint: null,
      canvas: { nodes: [], viewport: null },
    });
    await workspaces.save("ws-keepkeep", input(keep.id));
    await workspaces.save("ws-forget01", input(forget.id));
    await workspaces.save("ws-forget02", input(forget.id));

    await profiles.remove(forget.id);

    expect((await workspaces.list()).map((w) => w.id)).toEqual(["ws-keepkeep"]);
    expect((await profiles.list()).map((p) => p.id)).toEqual([keep.id]);
    await expect(profiles.remove(forget.id)).rejects.toMatchObject({ code: "profile_not_found" });
  });
});
