import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { findFreePort, isPortFree } from "./port.js";

const open: net.Server[] = [];

/** Occupy a port (let the OS pick one) and return it. */
function occupyPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    open.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe("isPortFree", () => {
  it("is false for a port that is in use", async () => {
    const port = await occupyPort();
    expect(await isPortFree(port)).toBe(false);
  });

  it("is true for a free port", async () => {
    const port = await occupyPort();
    await new Promise((r) => open.pop()?.close(r));
    expect(await isPortFree(port)).toBe(true);
  });
});

describe("findFreePort", () => {
  it("returns the preferred port when it is free", async () => {
    const port = await occupyPort();
    await new Promise((r) => open.pop()?.close(r));
    expect(await findFreePort(port)).toBe(port);
  });

  it("skips an occupied preferred port", async () => {
    const busy = await occupyPort();
    const found = await findFreePort(busy);
    expect(found).not.toBe(busy);
    expect(await isPortFree(found)).toBe(true);
  });
});
