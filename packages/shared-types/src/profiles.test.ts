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
  dataAccess: false,
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

describe("upgrading a version 1 connections file", () => {
  const { dataAccess: _dataAccess, ...withoutFlag } = profile;
  const version1 = (profiles: unknown) => ({
    format: "datacanvas-connections",
    schemaVersion: 1,
    profiles,
  });

  it("gives every saved connection dataAccess: false, so an upgrade never makes anything readable", () => {
    const parsed = parseConnectionsFile(
      version1([withoutFlag, { ...withoutFlag, id: "other-id-12345" }]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.schemaVersion).toBe(2);
    expect(parsed.file.profiles).toHaveLength(2);
    expect(parsed.file.profiles.every((p) => p.dataAccess === false)).toBe(true);
  });

  it("upgrades an empty file", () => {
    expect(parseConnectionsFile(version1([]))).toMatchObject({ ok: true });
  });

  it("does not turn a damaged version 1 file into a valid one", () => {
    expect(parseConnectionsFile(version1("nonsense")).ok).toBe(false);
    expect(parseConnectionsFile(version1([42])).ok).toBe(false);
    expect(parseConnectionsFile({ ...version1([]), profiles: undefined }).ok).toBe(false);
  });

  it("requires the flag in a version 2 file (it is never assumed to be on)", () => {
    expect(parseConnectionsFile({ ...emptyConnectionsFile(), profiles: [withoutFlag] }).ok).toBe(
      false,
    );
  });

  it("keeps a profile's setting when it is on", () => {
    const file = { ...emptyConnectionsFile(), profiles: [{ ...profile, dataAccess: true }] };
    expect(parseConnectionsFile(JSON.parse(JSON.stringify(file)))).toEqual({ ok: true, file });
  });
});
