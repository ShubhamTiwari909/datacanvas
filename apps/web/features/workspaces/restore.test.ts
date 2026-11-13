import type { TableDetailsEntry } from "@datacanvas/database-core";
import type { Workspace } from "@datacanvas/shared-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "@/lib/api-client";

type Names = Array<{ schema: string; name: string }>;
const getTables = vi.fn<(id: string, schema: string) => Promise<ApiResult<Names>>>();
const getTablesDetails =
  vi.fn<(id: string, refs: Names) => Promise<ApiResult<TableDetailsEntry[]>>>();
const getRelationships = vi.fn<(id: string) => Promise<ApiResult<never[]>>>();
vi.mock("@/features/explorer/api", () => ({ getTables, getTablesDetails, getRelationships }));

const { restoreWorkspace } = await import("./restore");
const { useCanvasStore } = await import("@/stores/canvas-store");
const { useMetadataStore } = await import("@/stores/metadata-store");

const C = "conn-1";
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = (code: string, message: string): ApiResult<never> => ({
  ok: false,
  error: { code, message, issues: [] },
});
const entry = (schema: string, name: string): TableDetailsEntry => ({
  table: { schema, name, kind: "table", comment: null, estimatedRowCount: null },
  columns: [
    {
      name: "id",
      ordinalPosition: 1,
      dataType: "integer",
      nullable: false,
      defaultValue: null,
      comment: null,
    },
    {
      name: "x",
      ordinalPosition: 2,
      dataType: "text",
      nullable: true,
      defaultValue: null,
      comment: null,
    },
  ],
  constraints: [],
  indexes: [],
});

const workspace = (
  nodes: Workspace["canvas"]["nodes"],
  viewport: Workspace["canvas"]["viewport"] = null,
): Workspace => ({
  format: "datacanvas-workspace",
  schemaVersion: 1,
  id: "ws-aaaaaaaa",
  name: "Layout",
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
  profileId: "profile-12345678",
  connectionHint: null,
  canvas: { nodes, viewport },
});
const saved = (name: string, x: number, y: number, expanded = false, schema = "public") => ({
  schema,
  name,
  x,
  y,
  expanded,
});
const canvas = () => useCanvasStore.getState().canvases[C];

beforeEach(() => {
  useCanvasStore.setState({ canvases: {}, focusRequest: null, busy: false, error: null });
  useMetadataStore.setState({ byConnection: {} });
  getTables.mockReset().mockImplementation(async (_id, schema) =>
    ok(
      schema === "public"
        ? [
            { schema, name: "users" },
            { schema, name: "orders" },
          ]
        : [],
    ),
  );
  getTablesDetails
    .mockReset()
    .mockImplementation(async (_id, refs) => ok(refs.map((r) => entry(r.schema, r.name))));
  getRelationships.mockReset().mockResolvedValue(ok([]));
});

describe("restoreWorkspace", () => {
  it("puts every saved table back at its saved position, expansion and viewport", async () => {
    const result = await restoreWorkspace(
      C,
      workspace([saved("users", 10, 20, true), saved("orders", 400, -5)], {
        x: 7,
        y: 8,
        zoom: 0.5,
      }),
    );

    expect(result).toEqual({ ok: true, missing: 0 });
    expect(canvas()?.nodes.map((n) => [n.data.name, n.position, n.data.expanded])).toEqual([
      ["users", { x: 10, y: 20 }, true],
      ["orders", { x: 400, y: -5 }, false],
    ]);
    expect(canvas()?.viewport).toEqual({ x: 7, y: 8, zoom: 0.5 });
  });

  it("loads structure for the tables in ONE bulk request, and lists each schema once", async () => {
    await restoreWorkspace(C, workspace([saved("users", 0, 0), saved("orders", 1, 1)]));
    expect(getTablesDetails).toHaveBeenCalledTimes(1);
    expect(getTables).toHaveBeenCalledTimes(1);
  });

  it("flags tables that no longer exist, keeps them where they were, and loads the others", async () => {
    const result = await restoreWorkspace(
      C,
      workspace([saved("users", 0, 0), saved("dropped_table", 300, 0)]),
    );

    expect(result).toEqual({ ok: true, missing: 1 });
    const byName = Object.fromEntries((canvas()?.nodes ?? []).map((n) => [n.data.name, n]));
    expect(byName["users"]?.data.missing).toBe(false);
    expect(byName["dropped_table"]).toMatchObject({
      position: { x: 300, y: 0 },
      data: { missing: true },
    });
    expect(getTablesDetails).toHaveBeenCalledWith(C, [{ schema: "public", name: "users" }]); // never asks for the missing one
  });

  it("treats a missing SCHEMA as missing tables, not as a failure", async () => {
    const result = await restoreWorkspace(
      C,
      workspace([saved("users", 0, 0), saved("t", 5, 5, false, "gone_schema")]),
    );
    // (the fake lists "gone_schema" as empty; a real server answers not_found, tested next)
    expect(result).toEqual({ ok: true, missing: 1 });
  });

  it("handles a schema the server reports as not_found", async () => {
    getTables.mockImplementation(async (_id, schema) =>
      schema === "public" ? ok([{ schema, name: "users" }]) : fail("not_found", "no such schema"),
    );
    const result = await restoreWorkspace(
      C,
      workspace([saved("users", 0, 0), saved("t", 5, 5, false, "gone_schema")]),
    );
    expect(result).toEqual({ ok: true, missing: 1 });
    expect(canvas()?.nodes.find((n) => n.data.schema === "gone_schema")?.data.missing).toBe(true);
  });

  it("works when EVERY saved table is gone (nothing to load)", async () => {
    const result = await restoreWorkspace(C, workspace([saved("a", 0, 0), saved("b", 1, 1)]));
    expect(result).toEqual({ ok: true, missing: 2 });
    expect(getTablesDetails).not.toHaveBeenCalled();
  });

  it("does not restore a table twice if the file lists it twice", async () => {
    await restoreWorkspace(C, workspace([saved("users", 1, 1), saved("users", 99, 99)]));
    expect(canvas()?.nodes).toHaveLength(1);
    expect(canvas()?.nodes[0]?.position).toEqual({ x: 1, y: 1 });
  });

  it("asks the view to fit everything when no viewport was saved, and to apply the viewport when there was one", async () => {
    await restoreWorkspace(C, workspace([saved("users", 0, 0)], null));
    expect(canvas()).toMatchObject({ layoutVersion: 1, restoreVersion: 0 });
    await restoreWorkspace(C, workspace([saved("users", 0, 0)], { x: 1, y: 2, zoom: 1 }));
    expect(canvas()?.restoreVersion).toBe(1);
  });

  it("replaces whatever was on the canvas", async () => {
    useCanvasStore
      .getState()
      .addTables(C, [{ ref: { schema: "public", name: "stale" }, columnCount: 1 }]);
    await restoreWorkspace(C, workspace([saved("users", 0, 0)]));
    expect(canvas()?.nodes.map((n) => n.data.name)).toEqual(["users"]);
  });

  it("fails without touching the canvas when the database cannot be reached", async () => {
    getTables.mockResolvedValue(fail("unreachable", "Could not reach the database server."));
    useCanvasStore
      .getState()
      .addTables(C, [{ ref: { schema: "public", name: "keep" }, columnCount: 1 }]);

    const result = await restoreWorkspace(C, workspace([saved("users", 0, 0)]));

    expect(result).toEqual({ ok: false, message: "Could not reach the database server." });
    expect(canvas()?.nodes.map((n) => n.data.name)).toEqual(["keep"]);
  });

  it("fails when the structure cannot be loaded", async () => {
    getTablesDetails.mockResolvedValue(fail("timeout", "The database did not respond in time."));
    expect(await restoreWorkspace(C, workspace([saved("users", 0, 0)]))).toEqual({
      ok: false,
      message: "The database did not respond in time.",
    });
  });
});
