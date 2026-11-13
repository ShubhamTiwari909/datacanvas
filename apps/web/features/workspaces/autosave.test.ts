import type { Workspace, WorkspaceInput } from "@datacanvas/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "@/lib/api-client";
import { useCanvasStore } from "@/stores/canvas-store";
import { usePersistenceStore } from "@/stores/persistence-store";
import { AUTOSAVE_DELAY_MS, createAutosaver, type Autosaver } from "./autosave";

const C = "conn-1";
const PROFILE = "profile-12345678";

type SaveCall = { id: string; input: WorkspaceInput };
let calls: SaveCall[];
let profileId: string | null;
let saveResult: () => Promise<ApiResult<Workspace>>;
let autosaver: Autosaver;
let stop: () => void;

const asWorkspace = (id: string, input: WorkspaceInput): Workspace => ({
  format: "datacanvas-workspace",
  schemaVersion: 1,
  id,
  name: input.name,
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
  profileId: input.profileId,
  connectionHint: input.connectionHint,
  canvas: input.canvas,
});

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  profileId = PROFILE;
  useCanvasStore.setState({ canvases: {}, focusRequest: null, busy: false, error: null });
  usePersistenceStore.setState({
    summaries: {},
    active: {},
    loaded: {},
    saveState: {},
    notices: {},
  });
  let counter = 0;
  saveResult = async () => ({
    ok: true,
    data: asWorkspace(calls.at(-1)?.id ?? "x", calls.at(-1)?.input as WorkspaceInput),
  });
  autosaver = createAutosaver({
    getProfileId: () => profileId,
    getHint: () => ({ connectionName: "Shop", database: "shop" }),
    save: async (id, input) => {
      calls.push({ id, input });
      return saveResult();
    },
    newId: () => `ws-generated${++counter}`.padEnd(12, "0"),
  });
  stop = autosaver.start();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

const add = (name: string) =>
  useCanvasStore.getState().addTables(C, [{ ref: { schema: "public", name }, columnCount: 3 }]);
const settle = () => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 5);

describe("autosave", () => {
  it("saves once, after the user pauses, creating the workspace on the first save", async () => {
    add("users");
    expect(calls).toHaveLength(0); // not immediately

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 100);
    expect(calls).toHaveLength(0); // still waiting

    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toMatchObject({
      name: "Layout",
      profileId: PROFILE,
      connectionHint: { connectionName: "Shop", database: "shop" },
      canvas: { nodes: [{ schema: "public", name: "users" }] },
    });
    expect(usePersistenceStore.getState().active[C]?.id).toBe(calls[0]?.id);
    expect(usePersistenceStore.getState().saveState[C]).toEqual({ status: "saved" });
    expect(usePersistenceStore.getState().summaries[PROFILE]).toHaveLength(1);
  });

  it("debounces: many quick changes are one save", async () => {
    add("a");
    await vi.advanceTimersByTimeAsync(300);
    add("b");
    await vi.advanceTimersByTimeAsync(300);
    add("c");
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.canvas.nodes).toHaveLength(3);
  });

  it("updates the SAME workspace on later saves", async () => {
    add("a");
    await settle();
    add("b");
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.id).toBe(calls[0]?.id);
  });

  it("does not write when only selection changes", async () => {
    add("a");
    await settle();
    useCanvasStore.getState().selectAll(C);
    useCanvasStore.getState().selectOnly(C, '["public","a"]');
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("saves a drag and a viewport change", async () => {
    add("a");
    await settle();
    useCanvasStore
      .getState()
      .applyChanges(C, [{ type: "position", id: '["public","a"]', position: { x: 500, y: 40 } }]);
    await settle();
    useCanvasStore.getState().setViewport(C, { x: 10, y: 10, zoom: 0.5 });
    await settle();
    expect(calls).toHaveLength(3);
    expect(calls[1]?.input.canvas.nodes[0]).toMatchObject({ x: 500, y: 40 });
    expect(calls[2]?.input.canvas.viewport).toEqual({ x: 10, y: 10, zoom: 0.5 });
  });

  it("never saves a connection that is not saved as a profile", async () => {
    profileId = null;
    add("a");
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("does not create a file for a canvas that was never used", async () => {
    useCanvasStore.getState().clearCanvas(C);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("does save an emptied canvas when a workspace already exists (so removals are kept)", async () => {
    add("a");
    await settle();
    useCanvasStore.getState().clearCanvas(C);
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.input.canvas.nodes).toEqual([]);
  });

  it("reports a failed save, and tries again on the next change", async () => {
    saveResult = async () => ({
      ok: false,
      error: { code: "storage_error", message: "Disk full.", issues: [] },
    });
    add("a");
    await settle();
    expect(usePersistenceStore.getState().saveState[C]).toEqual({
      status: "error",
      message: "Disk full.",
    });

    saveResult = async () => ({
      ok: true,
      data: asWorkspace(calls.at(-1)?.id ?? "x", calls.at(-1)?.input as WorkspaceInput),
    });
    add("b");
    await settle();
    expect(usePersistenceStore.getState().saveState[C]).toEqual({ status: "saved" });
    expect(calls).toHaveLength(2);
  });

  it("runs one save at a time, then saves again if the canvas changed meanwhile", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    saveResult = async () => {
      if (first) {
        first = false;
        await gate;
      }
      return {
        ok: true,
        data: asWorkspace(calls.at(-1)?.id ?? "x", calls.at(-1)?.input as WorkspaceInput),
      };
    };

    add("a");
    await settle(); // first save starts and waits on the gate
    add("b");
    await settle(); // second save is wanted, but must wait
    expect(calls).toHaveLength(1);

    release();
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.input.canvas.nodes).toHaveLength(2);
  });

  it("saves a rename", async () => {
    add("a");
    await settle();
    usePersistenceStore.getState().setActive(C, { id: calls[0]?.id ?? null, name: "Renamed" });
    await autosaver.flush(C);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.input.name).toBe("Renamed");
  });

  it("markClean makes the current canvas count as saved", async () => {
    add("a");
    autosaver.markClean(C); // as after opening a workspace
    await settle();
    expect(calls).toHaveLength(0);
    add("b");
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("forgets a connection that was disconnected, cancelling its pending save", async () => {
    add("a");
    useCanvasStore.getState().dropConnection(C);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("flush saves immediately instead of waiting for the delay", async () => {
    add("a");
    await autosaver.flush(C);
    expect(calls).toHaveLength(1);
  });

  it("stops saving after it is stopped", async () => {
    add("a");
    stop();
    await settle();
    expect(calls).toHaveLength(0);
  });
});
