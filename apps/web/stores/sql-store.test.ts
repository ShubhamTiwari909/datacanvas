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
const stateOf = (id: string) => useSqlStore.getState().byConnection[id]?.state;

beforeEach(() => {
  runStatement.mockReset();
  useSqlStore.setState({ byConnection: {} });
});

describe("the SQL store", () => {
  it("keeps the text and the row limit per connection, with defaults", () => {
    useSqlStore.getState().setText("a", "SELECT 1");
    useSqlStore.getState().setMaxRows("b", 100);
    expect(useSqlStore.getState().byConnection.a).toMatchObject({
      text: "SELECT 1",
      maxRows: 1000,
    });
    expect(useSqlStore.getState().byConnection.b).toMatchObject({ text: "", maxRows: 100 });
  });

  it("runs a statement, with the chosen limit, and keeps the result", async () => {
    useSqlStore.getState().setMaxRows("a", 100);
    runStatement.mockResolvedValue(ok({ result }));
    await useSqlStore.getState().run("a", "SELECT 1");
    expect(runStatement).toHaveBeenCalledWith(
      "a",
      { text: "SELECT 1", maxRows: 100 },
      expect.anything(),
    );
    expect(stateOf("a")).toEqual({ kind: "result", result });
  });

  it("is running while the request is out, and ignores a second run then", async () => {
    let finish: (value: unknown) => void = () => {};
    runStatement.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const first = useSqlStore.getState().run("a", "SELECT 1");
    expect(stateOf("a")?.kind).toBe("running");
    await useSqlStore.getState().run("a", "SELECT 2");
    expect(runStatement).toHaveBeenCalledTimes(1);
    finish(ok({ result }));
    await first;
    expect(stateOf("a")?.kind).toBe("result");
  });

  it("keeps the database's refusal with the text it was about and where the text started", async () => {
    const failure = { code: "42P01", message: "no table", position: 5 };
    runStatement.mockResolvedValue(ok({ failure }));
    useSqlStore.getState().setText("a", "-- c\nSELECT x");
    await useSqlStore.getState().run("a", "SELECT x", 5);
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
    await useSqlStore.getState().run("a", "SELECT 1");
    expect(stateOf("a")).toEqual({ kind: "cancelled" });
    runStatement.mockResolvedValue(fail("aborted"));
    await useSqlStore.getState().run("a", "SELECT 1");
    expect(stateOf("a")).toEqual({ kind: "cancelled" });
  });

  it("aborts the request when cancelled", async () => {
    let signal: AbortSignal | undefined;
    runStatement.mockImplementation(
      (_id: string, _body: unknown, s: AbortSignal) =>
        new Promise((resolve) => {
          signal = s;
          s.addEventListener("abort", () => resolve(fail("aborted")));
        }),
    );
    const running = useSqlStore.getState().run("a", "SELECT pg_sleep(30)");
    useSqlStore.getState().cancel("a");
    await running;
    expect(signal?.aborted).toBe(true);
    expect(stateOf("a")).toEqual({ kind: "cancelled" });
  });

  it("shows a failed request as an error with its code", async () => {
    runStatement.mockResolvedValue(fail("data_access_disabled", "Switch it on."));
    await useSqlStore.getState().run("a", "SELECT 1");
    expect(stateOf("a")).toEqual({
      kind: "error",
      code: "data_access_disabled",
      message: "Switch it on.",
    });
  });

  it("waits and tries again when the server is still letting go after a cancel", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      runStatement.mockImplementationOnce(
        (_i: string, _b: unknown, s: AbortSignal) =>
          new Promise((resolve) => {
            signal = s;
            s.addEventListener("abort", () => resolve(fail("aborted")));
          }),
      );
      const first = useSqlStore.getState().run("a", "SELECT pg_sleep(30)");
      useSqlStore.getState().cancel("a");
      await first;
      expect(signal?.aborted).toBe(true);

      runStatement.mockResolvedValueOnce(fail("sql_busy")).mockResolvedValueOnce(ok({ result }));
      const second = useSqlStore.getState().run("a", "SELECT 1");
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
    await useSqlStore.getState().run("busy-one", "SELECT 1");
    expect(runStatement).toHaveBeenCalledTimes(1);
    expect(stateOf("busy-one")).toMatchObject({ kind: "error", code: "sql_busy" });
  });

  it("drops everything of a connection, and cancels what is running", async () => {
    let signal: AbortSignal | undefined;
    runStatement.mockImplementation(
      (_i: string, _b: unknown, s: AbortSignal) =>
        new Promise((resolve) => {
          signal = s;
          s.addEventListener("abort", () => resolve(fail("aborted")));
        }),
    );
    const running = useSqlStore.getState().run("a", "SELECT pg_sleep(30)");
    useSqlStore.getState().forgetConnection("a");
    await running;
    expect(signal?.aborted).toBe(true);
    expect(useSqlStore.getState().byConnection.a).toBeUndefined();
  });
});
