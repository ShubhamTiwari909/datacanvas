import { describe, expect, it } from "vitest";
import { migrateToCurrent, type VersionedFileSpec } from "./versioned-file.js";

/** A pretend three-version format, to prove the migration CHAIN works before a real v2 exists. */
const spec: VersionedFileSpec = {
  format: "test-file",
  current: 3,
  migrations: {
    // v1 -> v2: rename "title" to "name".
    1: ({ title, ...rest }) => ({ ...rest, name: title }),
    // v2 -> v3: add a default for a new field.
    2: (data) => ({ ...data, color: "blue" }),
  },
};

const v1 = { format: "test-file", schemaVersion: 1, title: "My file" };

describe("migrateToCurrent", () => {
  it("runs every migration in order and stamps the new version", () => {
    const result = migrateToCurrent(v1, spec);
    expect(result).toEqual({
      ok: true,
      data: { format: "test-file", schemaVersion: 3, name: "My file", color: "blue" },
    });
  });

  it("only runs the migrations a file still needs", () => {
    const v2 = { format: "test-file", schemaVersion: 2, name: "Already renamed" };
    expect(migrateToCurrent(v2, spec)).toEqual({
      ok: true,
      data: { format: "test-file", schemaVersion: 3, name: "Already renamed", color: "blue" },
    });
  });

  it("passes a current file through untouched", () => {
    const current = { format: "test-file", schemaVersion: 3, name: "x", color: "red" };
    expect(migrateToCurrent(current, spec)).toEqual({ ok: true, data: current });
  });

  it("does not modify the object it was given", () => {
    const input = structuredClone(v1);
    migrateToCurrent(input, spec);
    expect(input).toEqual(v1);
  });

  it("refuses a file from a NEWER release instead of guessing", () => {
    const result = migrateToCurrent({ format: "test-file", schemaVersion: 4 }, spec);
    expect(result).toMatchObject({ ok: false, reason: "newer_version" });
    expect(!result.ok && result.message).toMatch(/newer version of DataCanvas/);
  });

  it.each([
    ["a string", "hello", "not_a_file"],
    ["null", null, "not_a_file"],
    ["an array", [], "not_a_file"],
    ["another kind of file", { format: "something-else", schemaVersion: 1 }, "wrong_format"],
    ["a missing version", { format: "test-file" }, "bad_version"],
    ["version 0", { format: "test-file", schemaVersion: 0 }, "bad_version"],
    ["a fractional version", { format: "test-file", schemaVersion: 1.5 }, "bad_version"],
    ["a version as text", { format: "test-file", schemaVersion: "1" }, "bad_version"],
  ])("rejects %s", (_label, input, reason) => {
    expect(migrateToCurrent(input, spec)).toMatchObject({ ok: false, reason });
  });

  it("reports a gap in the migration chain as unupgradable", () => {
    const broken: VersionedFileSpec = { ...spec, migrations: { 2: spec.migrations[2]! } };
    expect(migrateToCurrent(v1, broken)).toMatchObject({ ok: false, reason: "bad_version" });
  });

  it("never echoes the file's content in a message", () => {
    const result = migrateToCurrent(
      { format: "test-file", schemaVersion: 99, secret: "hunter2" },
      spec,
    );
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
});
