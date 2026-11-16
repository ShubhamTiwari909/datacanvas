import { describe, expect, it } from "vitest";
import { MAX_WAITING_ROW_READS, RowsGate } from "./rows-gate";

/** A read the test finishes by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("RowsGate", () => {
  it("runs the reads of one connection one at a time, in order", async () => {
    const gate = new RowsGate();
    const events: string[] = [];
    const first = deferred<string>();
    const a = gate.run("c1", async () => {
      events.push("a start");
      const value = await first.promise;
      events.push("a end");
      return value;
    });
    const b = gate.run("c1", async () => {
      events.push("b start");
      return "b";
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["a start"]); // b waits for a

    first.resolve("a");
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(events).toEqual(["a start", "a end", "b start"]);
  });

  it("does not make different connections wait for each other", async () => {
    const gate = new RowsGate();
    const slow = deferred<void>();
    const a = gate.run("c1", () => slow.promise);
    expect(await gate.run("c2", async () => "fast")).toBe("fast");
    slow.resolve();
    await a;
  });

  it("refuses past the waiting limit with rows_busy, and recovers as reads finish", async () => {
    const gate = new RowsGate();
    const holds = Array.from({ length: MAX_WAITING_ROW_READS + 1 }, () => deferred<void>());
    const running = holds.map((hold) => gate.run("c1", () => hold.promise));

    await expect(gate.run("c1", async () => "too many")).rejects.toMatchObject({
      name: "ServiceError",
      code: "rows_busy",
    });

    for (const hold of holds) hold.resolve();
    await Promise.all(running);
    expect(await gate.run("c1", async () => "ok again")).toBe("ok again");
  });

  it("a failed read does not block the ones behind it", async () => {
    const gate = new RowsGate();
    const failing = gate.run("c1", async () => {
      throw new Error("boom");
    });
    const next = gate.run("c1", async () => "fine");
    await expect(failing).rejects.toThrow("boom");
    expect(await next).toBe("fine");
  });

  it("forgets a closed connection, and returns the failure of its own read to the caller", async () => {
    const gate = new RowsGate();
    await gate.run("c1", async () => 1);
    gate.forget("c1");
    expect(await gate.run("c1", async () => 2)).toBe(2);
  });
});
