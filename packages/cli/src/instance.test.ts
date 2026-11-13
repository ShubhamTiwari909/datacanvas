import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDataDir, resolveDataDir } from "./data-dir.js";
import {
  findRunningInstance,
  instanceFile,
  isProcessAlive,
  parseInstance,
  readInstance,
  removeInstance,
  writeInstance,
  type InstanceInfo,
} from "./instance.js";

const info: InstanceInfo = {
  pid: process.pid,
  port: 4747,
  token: "a".repeat(43),
  version: "1.0.0",
};
const scratch = () => mkdtemp(path.join(os.tmpdir(), "dc-instance-"));

describe("parseInstance", () => {
  it("accepts a valid file", () => {
    expect(parseInstance(JSON.stringify(info))).toEqual(info);
  });

  it.each([
    ["not json", "{"],
    ["not an object", "5"],
    ["bad pid", JSON.stringify({ ...info, pid: 0 })],
    ["bad port", JSON.stringify({ ...info, port: 70000 })],
    ["token with odd characters", JSON.stringify({ ...info, token: "../../etc/passwd-xxxxxxxx" })],
    ["short token", JSON.stringify({ ...info, token: "abc" })],
    ["missing version", JSON.stringify({ pid: 1, port: 1, token: info.token })],
  ])("rejects %s", (_name, text) => {
    expect(parseInstance(text)).toBeNull();
  });
});

describe("instance file", () => {
  it("is written owner-only and read back", async () => {
    const dir = await scratch();
    await writeInstance(dir, info);
    expect(((await stat(instanceFile(dir))).mode & 0o777).toString(8)).toBe("600");
    expect(await readInstance(dir)).toEqual(info);
  });

  it("is only removed by the process that owns it", async () => {
    const dir = await scratch();
    await writeInstance(dir, info);
    await removeInstance(dir, info.pid + 1);
    expect(await readInstance(dir)).toEqual(info);
    await removeInstance(dir, info.pid);
    expect(await readInstance(dir)).toBeNull();
  });

  it("reads a missing or damaged file as 'nothing running'", async () => {
    const dir = await scratch();
    expect(await readInstance(dir)).toBeNull();
    await writeFile(instanceFile(dir), "garbage");
    expect(await readInstance(dir)).toBeNull();
  });
});

describe("findRunningInstance", () => {
  it("returns the instance when its process lives and the port answers", async () => {
    const dir = await scratch();
    await writeInstance(dir, info);
    expect(await findRunningInstance(dir, async () => true)).toEqual(info);
  });

  it("ignores a stale file: port not answering", async () => {
    const dir = await scratch();
    await writeInstance(dir, info);
    expect(await findRunningInstance(dir, async () => false)).toBeNull();
  });

  it("ignores a stale file: process gone", async () => {
    const dir = await scratch();
    await writeInstance(dir, { ...info, pid: 2_147_483_000 });
    expect(await findRunningInstance(dir, async () => true)).toBeNull();
  });

  it("knows which processes are alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_483_000)).toBe(false);
  });
});

describe("data folder", () => {
  it("honours DATACANVAS_HOME and defaults to ~/.datacanvas", () => {
    expect(resolveDataDir({ DATACANVAS_HOME: "/tmp/x" }, "/home/u")).toBe("/tmp/x");
    expect(resolveDataDir({}, "/home/u")).toBe(path.join("/home/u", ".datacanvas"));
    expect(resolveDataDir({ DATACANVAS_HOME: "  " }, "/home/u")).toBe(
      path.join("/home/u", ".datacanvas"),
    );
  });

  it("is created owner-only on first run, and reported as first run only once", async () => {
    const parent = await scratch();
    const dir = path.join(parent, "fresh");
    expect(await ensureDataDir(dir)).toBe(true);
    expect(((await stat(dir)).mode & 0o777).toString(8)).toBe("700");
    expect(await ensureDataDir(dir)).toBe(false);
  });
});
