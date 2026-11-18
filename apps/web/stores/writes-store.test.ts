import type { HistoryEntry, RoleResponse, WritesStatus } from "@datacanvas/shared-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "@/lib/api-client";

// Replace the network layer: these tests are about what the store keeps, and in which order
// answers are allowed to change it.
const getWritesStatus = vi.fn<(id: string) => Promise<ApiResult<WritesStatus>>>();
const unlockWrites = vi.fn<(id: string, database: string) => Promise<ApiResult<WritesStatus>>>();
const lockWrites = vi.fn<(id: string) => Promise<ApiResult<WritesStatus>>>();
const getRole = vi.fn<(id: string) => Promise<ApiResult<RoleResponse>>>();
const getWritesHistory = vi.fn<(id: string) => Promise<ApiResult<HistoryEntry[]>>>();
vi.mock("@/features/writes/api", () => ({
  getWritesStatus,
  unlockWrites,
  lockWrites,
  getRole,
  getWritesHistory,
}));

const { useWritesStore, WRITES_OFF } = await import("./writes-store");

const locked: WritesStatus = { enabled: true, local: true, dataAccess: true, unlocked: false };
const unlocked: WritesStatus = { ...locked, unlocked: true };
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const entry = (id: string): HistoryEntry => ({
  id,
  at: "2026-11-16T10:00:00.000Z",
  kind: "update_row",
  table: { schema: "public", name: "users" },
  columns: ["email"],
  statement: null,
  outcome: "applied",
  errorCode: null,
});

const state = () => useWritesStore.getState();
const status = () => state().byConnection["c1"]?.status;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  // Forget the connections the previous test used, which also resets their sequences.
  for (const id of Object.keys(state().byConnection)) state().forgetConnection(id);
  state().forgetConnection("c1");
  useWritesStore.setState({ byConnection: {} });
  for (const fn of [getWritesStatus, unlockWrites, lockWrites, getRole, getWritesHistory])
    fn.mockReset();
});

describe("status requests that finish out of order", () => {
  it("a slow read started before an unlock cannot undo the unlock", async () => {
    const slow = deferred<ApiResult<WritesStatus>>();
    getWritesStatus.mockReturnValueOnce(slow.promise);
    unlockWrites.mockResolvedValue(ok(unlocked));

    const read = state().refreshStatus("c1");
    expect(await state().unlock("c1", "shop")).toEqual({ ok: true });
    expect(status()).toEqual(unlocked);

    slow.resolve(ok(locked)); // the old answer arrives last
    await read;
    expect(status()).toEqual(unlocked);
  });

  it("a slow read started before a lock cannot show writes on again", async () => {
    useWritesStore.setState({ byConnection: { c1: { ...emptyFor(), status: unlocked } } });
    const slow = deferred<ApiResult<WritesStatus>>();
    getWritesStatus.mockReturnValueOnce(slow.promise);
    lockWrites.mockResolvedValue(ok(locked));

    const read = state().refreshStatus("c1");
    await state().lock("c1");
    expect(status()).toEqual(locked);

    slow.resolve(ok(unlocked));
    await read;
    expect(status()).toEqual(locked);
  });

  it("the newest read wins when two reads overlap", async () => {
    const first = deferred<ApiResult<WritesStatus>>();
    const second = deferred<ApiResult<WritesStatus>>();
    getWritesStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const a = state().refreshStatus("c1");
    const b = state().refreshStatus("c1");
    second.resolve(ok(unlocked));
    await b;
    first.resolve(ok(locked));
    await a;
    expect(status()).toEqual(unlocked);
  });

  it("an unlock overtaken by a newer read asks the server again rather than guessing", async () => {
    const unlocking = deferred<ApiResult<WritesStatus>>();
    unlockWrites.mockReturnValueOnce(unlocking.promise);
    getWritesStatus.mockResolvedValue(ok(unlocked));

    const unlock = state().unlock("c1", "shop");
    await state().refreshStatus("c1"); // started after the unlock: now the newest request
    getWritesStatus.mockClear();
    unlocking.resolve(ok(unlocked));
    await unlock;
    await flush();

    expect(getWritesStatus).toHaveBeenCalledTimes(1); // reconciled with the server
    expect(status()).toEqual(unlocked);
  });

  it("a failed lock shows what the server says, never writes on by assumption", async () => {
    useWritesStore.setState({ byConnection: { c1: { ...emptyFor(), status: unlocked } } });
    lockWrites.mockResolvedValue({
      ok: false,
      error: { code: "unreachable", message: "No answer.", issues: [] },
    });
    getWritesStatus.mockResolvedValue(ok(locked));
    expect(await state().lock("c1")).toMatchObject({ ok: false });
    expect(status()).toEqual(locked);
  });

  it("a server that cannot answer means no writes", async () => {
    getWritesStatus.mockResolvedValue({
      ok: false,
      error: { code: "not_found", message: "Gone.", issues: [] },
    });
    await state().refreshStatus("c1");
    expect(status()).toEqual(WRITES_OFF);
  });
});

describe("answers for a connection that was closed", () => {
  it.each([
    [
      "status",
      async (late: () => void) => {
        const slow = deferred<ApiResult<WritesStatus>>();
        getWritesStatus.mockReturnValueOnce(slow.promise);
        const call = state().refreshStatus("c1");
        return { call, finish: () => (slow.resolve(ok(unlocked)), late()) };
      },
    ],
    [
      "role",
      async (late: () => void) => {
        const slow = deferred<ApiResult<RoleResponse>>();
        getRole.mockReturnValueOnce(slow.promise);
        const call = state().loadRole("c1");
        return { call, finish: () => (slow.resolve(ok(someRole)), late()) };
      },
    ],
    [
      "history",
      async (late: () => void) => {
        const slow = deferred<ApiResult<HistoryEntry[]>>();
        getWritesHistory.mockReturnValueOnce(slow.promise);
        const call = state().loadHistory("c1");
        return { call, finish: () => (slow.resolve(ok([entry("h1")])), late()) };
      },
    ],
    [
      "unlock",
      async (late: () => void) => {
        const slow = deferred<ApiResult<WritesStatus>>();
        unlockWrites.mockReturnValueOnce(slow.promise);
        const call = state().unlock("c1", "shop");
        return { call, finish: () => (slow.resolve(ok(unlocked)), late()) };
      },
    ],
  ])("a late %s answer does not bring the connection's state back", async (_name, start) => {
    const { call, finish } = await start(() => undefined);
    state().forgetConnection("c1"); // the person disconnected meanwhile
    finish();
    await call;
    await flush();
    expect(state().byConnection["c1"]).toBeUndefined();
  });
});

describe("the role", () => {
  it("tells 'could not be read' from 'still loading', and a later success clears it", async () => {
    getRole.mockResolvedValueOnce({
      ok: false,
      error: { code: "unreachable", message: "No answer.", issues: [] },
    });
    await state().loadRole("c1");
    expect(state().byConnection["c1"]).toMatchObject({ role: null, roleFailed: true });

    getRole.mockResolvedValueOnce(ok(someRole));
    await state().loadRole("c1");
    expect(state().byConnection["c1"]).toMatchObject({ role: someRole, roleFailed: false });
  });
});

describe("the history", () => {
  it("keeps the oldest first, as the server's newest-first answer is turned round once", async () => {
    getWritesHistory.mockResolvedValue(ok([entry("h3"), entry("h2"), entry("h1")]));
    await state().loadHistory("c1");
    expect(state().byConnection["c1"]?.history.map((e) => e.id)).toEqual(["h1", "h2", "h3"]);

    // A change recorded afterwards goes at the end, so the dialog's one reversal shows it first.
    state().recordChange("c1", entry("h4"));
    expect(state().byConnection["c1"]?.history.map((e) => e.id)).toEqual(["h1", "h2", "h3", "h4"]);
  });

  it("does not list the same entry twice", async () => {
    state().recordChange("c1", entry("h1"));
    state().recordChange("c1", entry("h1"));
    expect(state().byConnection["c1"]?.history).toHaveLength(1);
  });

  it("a read started before a change was recorded cannot drop that change", async () => {
    const slow = deferred<ApiResult<HistoryEntry[]>>();
    getWritesHistory.mockReturnValueOnce(slow.promise);
    const read = state().loadHistory("c1");
    state().recordChange("c1", entry("new"));
    slow.resolve(ok([entry("old")])); // the server answered before it knew about "new"
    await read;
    expect(state().byConnection["c1"]?.history.map((e) => e.id)).toEqual(["new"]);
  });
});

function emptyFor() {
  return {
    status: WRITES_OFF,
    role: null,
    roleFailed: false,
    history: [],
    roleNoteDismissed: false,
    structureVersion: 0,
  };
}

const someRole: RoleResponse = {
  role: {
    roleName: "shop_owner",
    superuser: false,
    createRole: false,
    createDb: false,
    bypassRls: false,
    powerfulRoles: [],
    canCreateInDatabase: false,
    schemasWithCreate: 0,
    writableTables: 1,
    serverAddress: "127.0.0.1",
  },
  warnings: { read: [], write: [] },
};
