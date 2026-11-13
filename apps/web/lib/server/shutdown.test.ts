import { describe, expect, it } from "vitest";
import { disposeWithin } from "./shutdown";

describe("disposeWithin", () => {
  it("waits for dispose when it finishes in time", async () => {
    let done = false;
    await disposeWithin(async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    }, 500);
    expect(done).toBe(true);
  });

  it("gives up at the deadline when dispose hangs", async () => {
    const started = Date.now();
    await disposeWithin(() => new Promise<void>(() => {}), 50);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("swallows errors from dispose", async () => {
    await expect(
      disposeWithin(() => Promise.reject(new Error("boom")), 50),
    ).resolves.toBeUndefined();
  });
});
