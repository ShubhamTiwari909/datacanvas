/**
 * The shared server context. In development a hot reload keeps the context
 * object on `globalThis` while the code around it changes, so a context made by
 * older code (before the write service existed) can be found by newer code.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  disposeServerContext,
  getServerContext,
  setServerContextForTests,
  type ServerContext,
} from "./context";

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  // A private data folder: creating a context must never touch the real one.
  home = await mkdtemp(path.join(os.tmpdir(), "dc-context-"));
  previousHome = process.env.DATACANVAS_HOME;
  process.env.DATACANVAS_HOME = home;
});

afterEach(async () => {
  await disposeServerContext();
  setServerContextForTests(undefined);
  if (previousHome === undefined) delete process.env.DATACANVAS_HOME;
  else process.env.DATACANVAS_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe("getServerContext", () => {
  it("replaces a context left by older code that has no write service, and closes its connections", async () => {
    let closed = 0;
    const stale = {
      connections: {
        dispose: async () => {
          closed += 1;
        },
      },
      profiles: {},
      workspaces: {},
      snapshots: {},
    } as unknown as ServerContext;
    setServerContextForTests(stale);

    const context = getServerContext();
    expect(context).not.toBe(stale);
    expect(context.writes).toBeDefined();
    expect(typeof context.writes.status).toBe("function");
    expect(closed).toBe(1);
  });

  it("keeps a current context, so open connections survive a reload", () => {
    const first = getServerContext();
    expect(getServerContext()).toBe(first);
  });
});
