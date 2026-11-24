import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpControl } from "./mcp-control";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const ask = (control: McpControl, request = "SELECT 1") =>
  control.begin({ tool: "run_readonly_query", connection: "c1", connectionName: "Shop", request });

describe("the activity list", () => {
  it("records what was asked, newest first, bounded, and never a returned value", () => {
    const control = new McpControl({ maxActivity: 3 });
    const entries = ["a", "b", "c", "d"].map((r) => ask(control, r));
    control.finish(entries[3]!, "ok", { rows: 42, size: 3100 });
    const list = control.activity();
    expect(list.map((e) => e.request)).toEqual(["d", "c", "b"]);
    expect(list[0]).toMatchObject({ outcome: "ok", rows: 42, size: 3100 });
    // Nothing in an entry can hold a row: its fields are the request, an outcome and two counts.
    expect(Object.keys(list[0]!).sort()).toEqual([
      "at",
      "connection",
      "connectionName",
      "id",
      "outcome",
      "request",
      "rows",
      "size",
      "tool",
    ]);
  });

  it("keeps the first outcome of a call, and cuts a request that is too long to show", () => {
    const control = new McpControl();
    const entry = ask(control, "x".repeat(30000));
    expect(entry.request).toHaveLength(25000);
    control.finish(entry, "refused");
    control.finish(entry, "ok", { rows: 1 });
    expect(entry).toMatchObject({ outcome: "refused" });
    expect(entry.rows).toBeUndefined();
  });

  it("is forgotten, with the pause, when nothing is shared any more", () => {
    const control = new McpControl();
    ask(control);
    control.paused = true;
    control.reset();
    expect(control.activity()).toEqual([]);
    expect(control.paused).toBe(false);
  });

  it("hands out copies: changing the list does not change the record", () => {
    const control = new McpControl();
    ask(control);
    control.activity()[0]!.outcome = "ok";
    expect(control.activity()[0]!.outcome).toBe("waiting");
  });
});

describe("approval", () => {
  it("waits for the person: approve and deny answer the call, and the waiting list shows what was asked", async () => {
    const control = new McpControl();
    const first = ask(control, "SELECT * FROM users");
    const waiting = control.requestApproval(first, "c1", "Shop");
    expect(control.pending()).toEqual([
      expect.objectContaining({
        id: first.id,
        request: "SELECT * FROM users",
        connectionName: "Shop",
      }),
    ]);
    expect(control.decide(first.id, "approve")).toBe(true);
    await expect(waiting).resolves.toBe("approved");
    expect(control.pending()).toEqual([]);
    const second = ask(control);
    const denied = control.requestApproval(second, "c1", null);
    control.decide(second.id, "deny");
    await expect(denied).resolves.toBe("denied");
  });

  it("answers once: a second answer, or an answer to nothing, is false", async () => {
    const control = new McpControl();
    const entry = ask(control);
    const waiting = control.requestApproval(entry, "c1", null);
    expect(control.decide(entry.id, "approve")).toBe(true);
    expect(control.decide(entry.id, "deny")).toBe(false);
    expect(control.decide("c999", "approve")).toBe(false);
    await expect(waiting).resolves.toBe("approved");
  });

  it("gives up after the time limit: nothing waits for ever", async () => {
    const control = new McpControl({ approvalTimeoutMs: 2 * 60 * 1000 });
    const entry = ask(control);
    const waiting = control.requestApproval(entry, "c1", null);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 - 1);
    expect(control.pending()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    await expect(waiting).resolves.toBe("timeout");
    expect(control.pending()).toEqual([]);
  });

  it("stops waiting when the client gives up, and denies every waiting call when sharing ends", async () => {
    const control = new McpControl();
    const aborted = new AbortController();
    const entry = ask(control);
    const waiting = control.requestApproval(entry, "c1", null, aborted.signal);
    aborted.abort();
    await expect(waiting).resolves.toBe("aborted");
    const already = new AbortController();
    already.abort();
    await expect(control.requestApproval(ask(control), "c1", null, already.signal)).resolves.toBe(
      "aborted",
    );
    const a = control.requestApproval(ask(control), "c1", null);
    const b = control.requestApproval(ask(control), "c2", null);
    control.denyAll("c1");
    await expect(a).resolves.toBe("denied");
    expect(control.pending()).toHaveLength(1);
    control.denyAll();
    await expect(b).resolves.toBe("denied");
  });
});

describe("the rate limit", () => {
  it("serves 30 calls a minute and then says no, until the minute has passed", () => {
    let clock = 1_000_000;
    const control = new McpControl({ now: () => clock });
    for (let i = 0; i < 30; i++) expect(control.allowCall()).toBe(true);
    expect(control.allowCall()).toBe(false);
    clock += 59_000;
    expect(control.allowCall()).toBe(false);
    clock += 2_000;
    expect(control.allowCall()).toBe(true);
  });
});
