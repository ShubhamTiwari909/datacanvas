import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDataDir } from "./data-dir";

describe("resolveDataDir", () => {
  it("defaults to .datacanvas in the home folder", () => {
    expect(resolveDataDir({}, "/home/alice")).toBe(path.join("/home/alice", ".datacanvas"));
  });

  it("can be overridden with DATACANVAS_HOME", () => {
    expect(resolveDataDir({ DATACANVAS_HOME: "/data/dc" }, "/home/alice")).toBe(
      path.resolve("/data/dc"),
    );
  });

  it("ignores a blank override", () => {
    expect(resolveDataDir({ DATACANVAS_HOME: "   " }, "/home/alice")).toBe(
      path.join("/home/alice", ".datacanvas"),
    );
  });
});
