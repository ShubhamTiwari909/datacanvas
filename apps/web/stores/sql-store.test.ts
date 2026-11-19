import type { SqlResult } from "@datacanvas/shared-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runStatement = vi.fn();
vi.mock("@/features/sql/api", () => ({
  runStatement: (...args: unknown[]) => runStatement(...args),
}));

import { useSqlStore } from "./sql-store";

const result: SqlResult = {
  columns: [{ name: "v", dataType: "text" }],
  rows: [["x"]],
  truncated: false,
  command: "SELECT",
  cutCells: 0,
  elapsedMs: 4,
};
const ok = (data: unknown) => ({ ok: true, data });
const fail = (code: string, message = "m") => ({ ok: false, error: { code, message, issues: [] } });

beforeEach(() => {
  runStatement.mockReset();
  useSqlStore.setState({ byConnection: {} });
});

const tab = (id: string, tabId = "tab-1") =>
  useSqlStore.getState().byConnection[id]?.tabs.find((t) => t.id === tabId);
const stateOf = (id: string, tabId = "tab-1") => tab(id, tabId)?.state;
const sql = (id: string) => useSqlStore.getState().byConnection[id]!;

/** A request that stays open until it is aborted or finished by the test. */
function pending() {
  let signal: AbortSignal | undefined;
  let finish: (value: unknown) => void = () => {};
  runStatement.mockImplementationOnce(
    (_i: string, _b: unknown, s: AbortSignal) =>
      new Promise((resolve) => {
        signal = s;
        finish = resolve;
        s.addEventListener("abort", () => resolve(fail("aborted")));
      }),
  );
  return { signal: () => signal, finish: (v: unknown) => finish(v) };
}

describe("the SQL store: tabs", () => {
  it("starts with one empty tab, and names new ones by a number that is never reused", () => {
    const { newTab, closeTab, setText } = useSqlStore.getState();
    setText("a", "tab-1", "x");
    expect(sql("a").tabs.map((t) => t.name)).toEqual(["Query 1"]);
    const second = newTab("a")!;
    expect(sql("a").activeId).toBe(second);
    closeTab("a", second);
    expect(newTab("a")).toBe("tab-3");
    expect(sql("a").tabs.map((t) => t.name)).toEqual(["Query 1", "Query 3"]);
  });

  it("puts a new tab after the active one and shows it", () => {
    const { newTab, selectTab } = useSqlStore.getState();
    newTab("a");
    newTab("a");
    selectTab("a", "tab-1");
    newTab("a", { name: "Opened", text: "SELECT 1" });
    expect(sql("a").tabs.map((t) => t.name)).toEqual(["Query 1", "Opened", "Query 2", "Query 3"]);
    expect(tab("a", sql("a").activeId)).toMatchObject({ name: "Opened", text: "SELECT 1" });
  });

  it("stops at the limit of tabs", () => {
    for (let i = 1; i < 20; i++) expect(useSqlStore.getState().newTab("a")).not.toBeNull();
    expect(useSqlStore.getState().newTab("a")).toBeNull();
    expect(useSqlStore.getState().duplicateTab("a", "tab-1")).toBeNull();
    expect(sql("a").tabs).toHaveLength(20);
  });

  it("closes a tab and shows its neighbour; the last tab is replaced by an empty one", () => {
    const { newTab, closeTab, setText, selectTab } = useSqlStore.getState();
    setText("a", "tab-1", "one");
    newTab("a");
    newTab("a");
    selectTab("a", "tab-2");
    closeTab("a", "tab-2");
    expect(sql("a").activeId).toBe("tab-3");
    closeTab("a", "tab-3");
    expect(sql("a").activeId).toBe("tab-1");
    // Closing a tab that is not shown keeps the one that is.
    newTab("a");
    selectTab("a", "tab-1");
    closeTab("a", "tab-4");
    expect(sql("a").activeId).toBe("tab-1");
    closeTab("a", "tab-1");
    expect(sql("a").tabs).toHaveLength(1);
    expect(sql("a").tabs[0]).toMatchObject({ id: "tab-5", name: "Query 5", text: "" });
    expect(sql("a").activeId).toBe("tab-5");
  });

  it("renames a tab, ignoring an empty name and cutting a long one", () => {
    const { renameTab } = useSqlStore.getState();
    renameTab("a", "tab-1", "  Orders  ");
    expect(tab("a")?.name).toBe("Orders");
    renameTab("a", "tab-1", "   ");
    expect(tab("a")?.name).toBe("Orders");
    renameTab("a", "tab-1", "x".repeat(100));
    expect(tab("a")?.name).toHaveLength(60);
  });

  it("duplicates a tab with its text and limit but not its result, right after it", () => {
    const { setText, setMaxRows, duplicateTab, newTab, selectTab } = useSqlStore.getState();
    setText("a", "tab-1", "SELECT 1");
    setMaxRows("a", "tab-1", 100);
    newTab("a");
    selectTab("a", "tab-2");
    const copy = duplicateTab("a", "tab-1")!;
    expect(sql("a").tabs.map((t) => t.id)).toEqual(["tab-1", copy, "tab-2"]);
    expect(tab("a", copy)).toMatchObject({
      name: "Query 1 (copy)",
      text: "SELECT 1",
      maxRows: 100,
      state: { kind: "idle" },
    });
    expect(sql("a").activeId).toBe(copy);
  });

  it("keeps the text and the row limit per tab and per connection", () => {
    const { setText, setMaxRows, newTab } = useSqlStore.getState();
    setText("a", "tab-1", "SELECT 1");
    newTab("a");
    setMaxRows("a", "tab-2", 100);
    setText("b", "tab-1", "SELECT 2");
    expect(tab("a")).toMatchObject({ text: "SELECT 1", maxRows: 1000 });
    expect(tab("a", "tab-2")).toMatchObject({ text: "", maxRows: 100 });
    expect(tab("b")?.text).toBe("SELECT 2");
  });

  it("ignores changes to a tab that does not exist", () => {
    useSqlStore.getState().setText("a", "tab-9", "x");
    useSqlStore.getState().renameTab("a", "tab-9", "x");
    expect(useSqlStore.getState().byConnection.a).toBeUndefined();
  });
});

describe("the SQL store: running", () => {
  it("runs a statement from a tab, with its limit, and keeps the result in that tab", async () => {
    const { setMaxRows, newTab, run } = useSqlStore.getState();
    newTab("a");
    setMaxRows("a", "tab-2", 100);
    runStatement.mockResolvedValue(ok({ result }));
    await run("a", "tab-2", "SELECT 1");
    expect(runStatement).toHaveBeenCalledWith(
      "a",
      { text: "SELECT 1", maxRows: 100 },
      expect.anything(),
    );
    expect(stateOf("a", "tab-2")).toEqual({ kind: "result", result });
    expect(stateOf("a", "tab-1")).toEqual({ kind: "idle" });
  });

  it("runs one statement at a time per connection, whichever tab asks", async () => {
    const { newTab, run } = useSqlStore.getState();
    newTab("a");
    const request = pending();
    const first = run("a", "tab-1", "SELECT pg_sleep(30)");
    expect(stateOf("a")?.kind).toBe("running");
    await run("a", "tab-2", "SELECT 2");
    expect(runStatement).toHaveBeenCalledTimes(1);
    expect(stateOf("a", "tab-2")).toEqual({ kind: "idle" });
    request.finish(ok({ result }));
    await first;
    expect(stateOf("a")?.kind).toBe("result");
    // Another connection is not held up.
    runStatement.mockResolvedValue(ok({ result }));
    await run("b", "tab-1", "SELECT 3");
    expect(stateOf("b")?.kind).toBe("result");
  });

  it("keeps the database's refusal with the text it was about, where it started and the whole text", async () => {
    const failure = { code: "42P01", message: "no table", position: 5 };
    runStatement.mockResolvedValue(ok({ failure }));
    useSqlStore.getState().setText("a", "tab-1", "-- c\nSELECT x");
    await useSqlStore.getState().run("a", "tab-1", "SELECT x", 5);
    expect(stateOf("a")).toEqual({
      kind: "failure",
      failure,
      ranText: "SELECT x",
      base: 5,
      docText: "-- c\nSELECT x",
    });
  });

  it("shows a cancel from the server and an abort from here the same way", async () => {
    runStatement.mockResolvedValue(
      ok({ failure: { code: "cancelled", message: "m", position: null } }),
    );
    await useSqlStore.getState().run("a", "tab-1", "SELECT 1");
    expect(stateOf("a")).toEqual({ kind: "cancelled" });
    runStatement.mockResolvedValue(fail("aborted"));
    await useSqlStore.getState().run("a", "tab-1", "SELECT 1");
    expect(stateOf("a")).toEqual({ kind: "cancelled" });
  });

  it("aborts the request when cancelled", async () => {
    const request = pending();
    const running = useSqlStore.getState().run("a", "tab-1", "SELECT pg_sleep(30)");
    useSqlStore.getState().cancel("a");
    await running;
    expect(request.signal()?.aborted).toBe(true);
    expect(stateOf("a")).toEqual({ kind: "cancelled" });
  });

  it("cancels the statement when the tab that runs it is closed, and keeps the other tabs", async () => {
    const { newTab, run, closeTab } = useSqlStore.getState();
    newTab("a");
    const request = pending();
    const running = run("a", "tab-1", "SELECT pg_sleep(30)");
    closeTab("a", "tab-1");
    await running;
    expect(request.signal()?.aborted).toBe(true);
    expect(sql("a").tabs.map((t) => t.id)).toEqual(["tab-2"]);
    expect(stateOf("a", "tab-2")).toEqual({ kind: "idle" });
  });

  it("shows a failed request as an error with its code", async () => {
    runStatement.mockResolvedValue(fail("data_access_disabled", "Switch it on."));
    await useSqlStore.getState().run("a", "tab-1", "SELECT 1");
    expect(stateOf("a")).toEqual({
      kind: "error",
      code: "data_access_disabled",
      message: "Switch it on.",
    });
  });

  it("waits and tries again when the server is still letting go after a cancel", async () => {
    vi.useFakeTimers();
    try {
      const request = pending();
      const first = useSqlStore.getState().run("a", "tab-1", "SELECT pg_sleep(30)");
      useSqlStore.getState().cancel("a");
      await first;
      expect(request.signal()?.aborted).toBe(true);

      runStatement.mockResolvedValueOnce(fail("sql_busy")).mockResolvedValueOnce(ok({ result }));
      const second = useSqlStore.getState().run("a", "tab-1", "SELECT 1");
      await vi.advanceTimersByTimeAsync(400);
      await second;
      expect(runStatement).toHaveBeenCalledTimes(3);
      expect(stateOf("a")?.kind).toBe("result");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hide a busy connection that nobody cancelled", async () => {
    runStatement.mockResolvedValue(fail("sql_busy", "busy"));
    await useSqlStore.getState().run("busy-one", "tab-1", "SELECT 1");
    expect(runStatement).toHaveBeenCalledTimes(1);
    expect(stateOf("busy-one")).toMatchObject({ kind: "error", code: "sql_busy" });
  });

  it("drops everything of a connection, and cancels what is running", async () => {
    const request = pending();
    const running = useSqlStore.getState().run("a", "tab-1", "SELECT pg_sleep(30)");
    useSqlStore.getState().forgetConnection("a");
    await running;
    expect(request.signal()?.aborted).toBe(true);
    expect(useSqlStore.getState().byConnection.a).toBeUndefined();
  });
});

describe("the SQL store: history", () => {
  const history = (id: string) => useSqlStore.getState().byConnection[id]?.history ?? [];

  it("keeps what ran, newest first, with how it went", async () => {
    const { run, setText } = useSqlStore.getState();
    setText("a", "tab-1", "x");
    runStatement.mockResolvedValueOnce(ok({ result }));
    await run("a", "tab-1", "SELECT 1");
    runStatement.mockResolvedValueOnce(
      ok({ failure: { code: "42P01", message: "no table", position: 3 } }),
    );
    await run("a", "tab-1", "SELECT * FROM nope");
    runStatement.mockResolvedValueOnce(
      ok({ failure: { code: "cancelled", message: "m", position: null } }),
    );
    await run("a", "tab-1", "SELECT pg_sleep(30)");
    expect(history("a").map((h) => [h.text, h.outcome, h.code, h.rows])).toEqual([
      ["SELECT pg_sleep(30)", "cancelled", null, null],
      ["SELECT * FROM nope", "failed", "42P01", null],
      ["SELECT 1", "ok", null, 1],
    ]);
    expect(history("a")[2]).toMatchObject({ tabName: "Query 1", elapsedMs: 4 });
    expect(new Set(history("a").map((h) => h.id)).size).toBe(3);
  });

  it("records a cancel made here, and never a request that failed", async () => {
    const request = pending();
    const running = useSqlStore.getState().run("a", "tab-1", "SELECT pg_sleep(30)");
    useSqlStore.getState().cancel("a");
    await running;
    expect(history("a").map((h) => h.outcome)).toEqual(["cancelled"]);
    // (On another connection, where nothing was cancelled, so a busy answer is not retried.)
    runStatement.mockResolvedValueOnce(fail("sql_busy", "busy"));
    await useSqlStore.getState().run("c", "tab-1", "SELECT 1");
    runStatement.mockResolvedValueOnce(fail("data_access_disabled", "off"));
    await useSqlStore.getState().run("c", "tab-1", "SELECT 2");
    expect(history("c")).toEqual([]);
    expect(history("a")).toHaveLength(1);
    expect(request.signal()?.aborted).toBe(true);
  });

  it("keeps the statement even when its tab was closed while it ran", async () => {
    const { newTab, closeTab, run } = useSqlStore.getState();
    newTab("a");
    const request = pending();
    const running = run("a", "tab-1", "SELECT slow()");
    closeTab("a", "tab-1");
    await running;
    expect(request.signal()?.aborted).toBe(true);
    expect(history("a").map((h) => [h.text, h.tabName])).toEqual([["SELECT slow()", "Query 1"]]);
  });

  it("keeps at most 200 entries, and a bounded number of characters", async () => {
    runStatement.mockResolvedValue(ok({ result }));
    for (let i = 0; i < 205; i++) await useSqlStore.getState().run("a", "tab-1", `SELECT ${i}`);
    expect(history("a")).toHaveLength(200);
    expect(history("a")[0]?.text).toBe("SELECT 204");
    expect(history("a").at(-1)?.text).toBe("SELECT 5");

    useSqlStore.setState({ byConnection: {} });
    const big = `SELECT '${"x".repeat(900_000)}'`;
    for (let i = 0; i < 4; i++) await useSqlStore.getState().run("b", "tab-1", big);
    // Two fit under two million characters; the newest is always kept.
    expect(history("b").length).toBe(2);
    // A single statement over the limit is still kept: it is the one just run.
    await useSqlStore.getState().run("d", "tab-1", `SELECT '${"x".repeat(2_500_000)}'`);
    expect(history("d")).toHaveLength(1);
  });

  it("clears the history of one connection only, and drops it with the connection", async () => {
    runStatement.mockResolvedValue(ok({ result }));
    await useSqlStore.getState().run("a", "tab-1", "SELECT 1");
    await useSqlStore.getState().run("b", "tab-1", "SELECT 2");
    useSqlStore.getState().clearHistory("a");
    expect(history("a")).toEqual([]);
    expect(history("b")).toHaveLength(1);
    useSqlStore.getState().forgetConnection("b");
    expect(history("b")).toEqual([]);
  });
});

describe("the SQL store: a statement with a prefix (explain)", () => {
  it("sends the prefix, keeps the person's text, and counts the position from it", async () => {
    runStatement.mockResolvedValue(
      ok({ failure: { code: "42P01", message: "no table", position: 8 + 15 } }),
    );
    await useSqlStore.getState().run("a", "tab-1", "SELECT * FROM nope", 0, "EXPLAIN ");
    expect(runStatement).toHaveBeenCalledWith(
      "a",
      { text: "EXPLAIN SELECT * FROM nope", maxRows: 1000 },
      expect.anything(),
    );
    expect(stateOf("a")).toMatchObject({
      kind: "failure",
      ranText: "SELECT * FROM nope",
      failure: { position: 15 },
    });
    expect(useSqlStore.getState().byConnection.a!.history[0]?.text).toBe(
      "EXPLAIN SELECT * FROM nope",
    );
  });

  it("has no position for an error in the prefix itself", async () => {
    runStatement.mockResolvedValue(
      ok({ failure: { code: "42601", message: "syntax", position: 3 } }),
    );
    await useSqlStore.getState().run("a", "tab-1", "x", 0, "EXPLAIN ");
    expect(stateOf("a")).toMatchObject({ failure: { position: null } });
  });
});

describe("the SQL store: error positions", () => {
  it("turns PostgreSQL's character position into the editor's UTF-16 position", async () => {
    const text = "SELECT '😀', x FROM nope";
    runStatement.mockResolvedValue(
      ok({ failure: { code: "42703", message: "no x", position: 13 } }),
    );
    await useSqlStore.getState().run("a", "tab-1", text);
    expect(stateOf("a")).toMatchObject({ failure: { position: 14 } });
  });
});
