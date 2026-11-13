import { nodeIdFor } from "@datacanvas/canvas-engine";
import type { TableDetailsEntry } from "@datacanvas/database-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "@/lib/api-client";

const getTablesDetails =
  vi.fn<
    (
      id: string,
      refs: Array<{ schema: string; name: string }>,
    ) => Promise<ApiResult<TableDetailsEntry[]>>
  >();
const getRelationships = vi.fn<(id: string) => Promise<ApiResult<never[]>>>();
const getTables =
  vi.fn<
    (id: string, schema: string) => Promise<ApiResult<Array<{ schema: string; name: string }>>>
  >();
vi.mock("@/features/explorer/api", () => ({ getTablesDetails, getRelationships, getTables }));

const { addSchemaToCanvas, addTablesToCanvas, MAX_TABLES_ADDED_AT_ONCE } =
  await import("./add-tables");
const { useCanvasStore } = await import("@/stores/canvas-store");
const { useMetadataStore } = await import("@/stores/metadata-store");

const entry = (name: string): TableDetailsEntry => ({
  table: { schema: "public", name, kind: "table", comment: null, estimatedRowCount: null },
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
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const ref = (name: string) => ({ schema: "public", name });
const nodes = () => useCanvasStore.getState().canvases["c1"]?.nodes ?? [];

beforeEach(() => {
  useCanvasStore.setState({ canvases: {}, focusRequest: null, busy: false, error: null });
  useMetadataStore.setState({ byConnection: {} });
  getTablesDetails
    .mockReset()
    .mockImplementation(async (_id, refs) => ok(refs.map((r) => entry(r.name))));
  getRelationships.mockReset().mockResolvedValue(ok([]));
  getTables.mockReset();
});

describe("addTablesToCanvas", () => {
  it("loads the structure first, then adds nodes that know their column count", async () => {
    const added = await addTablesToCanvas("c1", [ref("a"), ref("b")]);

    expect(added).toBe(true);
    expect(nodes().map((n) => n.id)).toEqual([nodeIdFor(ref("a")), nodeIdFor(ref("b"))]);
    expect(nodes()[0]?.data.columnCount).toBe(2);
    expect(useCanvasStore.getState()).toMatchObject({ busy: false, error: null });
  });

  it("asks the view to focus the first table when requested", async () => {
    await addTablesToCanvas("c1", [ref("a")], { focus: true });
    expect(useCanvasStore.getState().focusRequest).toEqual({
      connectionId: "c1",
      nodeId: nodeIdFor(ref("a")),
    });
  });

  it("adds nothing and reports the error when loading fails", async () => {
    getTablesDetails.mockResolvedValue({
      ok: false,
      error: { code: "unreachable", message: "Could not reach the database server.", issues: [] },
    });
    const added = await addTablesToCanvas("c1", [ref("a")]);

    expect(added).toBe(false);
    expect(nodes()).toEqual([]);
    expect(useCanvasStore.getState()).toMatchObject({
      busy: false,
      error: "Could not reach the database server.",
    });
  });

  it("does not request structure it already has when the same table is added again", async () => {
    await addTablesToCanvas("c1", [ref("a")]);
    await addTablesToCanvas("c1", [ref("a")]);
    expect(getTablesDetails).toHaveBeenCalledTimes(1);
    expect(nodes()).toHaveLength(1);
  });
});

describe("addSchemaToCanvas", () => {
  it("adds every table of the schema", async () => {
    getTables.mockResolvedValue(ok([ref("a"), ref("b"), ref("c")]));
    await addSchemaToCanvas("c1", "public");
    expect(nodes()).toHaveLength(3);
  });

  it("adds only the first batch of a huge schema and says so", async () => {
    const many = Array.from({ length: MAX_TABLES_ADDED_AT_ONCE + 25 }, (_v, i) => ref(`t${i}`));
    getTables.mockResolvedValue(ok(many));
    await addSchemaToCanvas("c1", "public");

    expect(nodes()).toHaveLength(MAX_TABLES_ADDED_AT_ONCE);
    expect(useCanvasStore.getState().error).toContain(`${many.length} tables`);
  });

  it("reports a failure to list the schema", async () => {
    getTables.mockResolvedValue({
      ok: false,
      error: { code: "not_found", message: "Missing schema.", issues: [] },
    });
    expect(await addSchemaToCanvas("c1", "nope")).toBe(false);
    expect(useCanvasStore.getState().error).toBe("Missing schema.");
  });
});
