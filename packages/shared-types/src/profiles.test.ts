import { describe, expect, it } from "vitest";
import { connectionProfileSchema, emptyConnectionsFile, parseConnectionsFile } from "./profiles.js";

const profile = {
  id: "profile-12345678",
  provider: "postgresql",
  name: "Shop",
  host: "localhost",
  port: 5432,
  database: "shop",
  username: "alice",
  sslMode: "disable",
  createdAt: "2026-11-13T10:00:00.000Z",
} as const;

describe("connection profiles", () => {
  it("has no place for a password: one passed in is stripped", () => {
    const parsed = connectionProfileSchema.parse({
      ...profile,
      password: "hunter2",
      hasPassword: true,
    });
    expect(JSON.stringify(parsed)).not.toContain("hunter2");
    expect(parsed).not.toHaveProperty("password");
    expect(parsed).not.toHaveProperty("hasPassword");
  });

  it("round-trips an empty and a populated file", () => {
    expect(parseConnectionsFile(emptyConnectionsFile())).toEqual({
      ok: true,
      file: emptyConnectionsFile(),
    });
    const file = { ...emptyConnectionsFile(), profiles: [profile] };
    expect(parseConnectionsFile(JSON.parse(JSON.stringify(file)))).toEqual({ ok: true, file });
  });

  it("rejects other kinds of file and damaged content with fixed messages", () => {
    expect(parseConnectionsFile({ format: "datacanvas-workspace", schemaVersion: 1 }).ok).toBe(
      false,
    );
    const damaged = parseConnectionsFile({
      ...emptyConnectionsFile(),
      profiles: [{ ...profile, port: "x" }],
    });
    expect(damaged).toEqual({
      ok: false,
      message: "The saved connections file is damaged or incomplete.",
    });
  });

  it("refuses a file from a newer release", () => {
    const result = parseConnectionsFile({ ...emptyConnectionsFile(), schemaVersion: 9 });
    expect(!result.ok && result.message).toMatch(/newer version/);
  });
});
