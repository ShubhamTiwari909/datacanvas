import { MAX_TABLES_PER_DETAILS_REQUEST } from "@datacanvas/shared-types";
import type { TableDetailsEntry } from "@datacanvas/database-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "@/lib/api-client";

// Replace the network layer: these tests are about the cache, not about HTTP.
const getTablesDetails =
  vi.fn<
    (
      id: string,
      refs: Array<{ schema: string; name: string }>,
    ) => Promise<ApiResult<TableDetailsEntry[]>>
  >();
const getRelationships = vi.fn<(id: string) => Promise<ApiResult<never[]>>>();
vi.mock("@/features/explorer/api", () => ({ getTablesDetails, getRelationships }));

const { useMetadataStore } = await import("./metadata-store");

const entry = (name: string): TableDetailsEntry => ({
  table: { schema: "public", name, kind: "table", comment: null, estimatedRowCount: null },
  columns: [],
  constraints: [],
  indexes: [],
});
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const refs = (n: number) =>
  Array.from({ length: n }, (_v, i) => ({ schema: "public", name: `t${i}` }));
const cached = () => useMetadataStore.getState().byConnection["c1"];

beforeEach(() => {
  useMetadataStore.setState({ byConnection: {} });
  getTablesDetails.mockReset();
  getRelationships.mockReset();
  getTablesDetails.mockImplementation(async (_id, requested) =>
    ok(requested.map((r) => entry(r.name))),
  );
  getRelationships.mockResolvedValue(ok([]));
});

describe("ensureTables", () => {
  it("fetches missing tables and caches them", async () => {
    const result = await useMetadataStore.getState().ensureTables("c1", refs(3));
    expect(result).toEqual({ ok: true });
    expect(Object.keys(cached()?.tables ?? {})).toHaveLength(3);
    expect(getTablesDetails).toHaveBeenCalledTimes(1);
  });

  it("does not ask again for tables it already has", async () => {
    await useMetadataStore.getState().ensureTables("c1", refs(3));
    await useMetadataStore.getState().ensureTables("c1", refs(3));
    expect(getTablesDetails).toHaveBeenCalledTimes(1);
  });

  it("asks only for the tables that are missing", async () => {
    await useMetadataStore.getState().ensureTables("c1", refs(2));
    await useMetadataStore.getState().ensureTables("c1", refs(4));
    expect(getTablesDetails).toHaveBeenLastCalledWith("c1", refs(4).slice(2));
  });

  it("splits a very long list into requests the server accepts", async () => {
    await useMetadataStore.getState().ensureTables("c1", refs(MAX_TABLES_PER_DETAILS_REQUEST + 10));
    expect(getTablesDetails).toHaveBeenCalledTimes(2);
    expect(getTablesDetails.mock.calls[0]?.[1]).toHaveLength(MAX_TABLES_PER_DETAILS_REQUEST);
    expect(getTablesDetails.mock.calls[1]?.[1]).toHaveLength(10);
  });

  it("reports the server's message and caches nothing on failure", async () => {
    getTablesDetails.mockResolvedValue({
      ok: false,
      error: {
        code: "not_found",
        message: "The requested schema or table does not exist.",
        issues: [],
      },
    });
    const result = await useMetadataStore.getState().ensureTables("c1", refs(2));
    expect(result).toEqual({ ok: false, message: "The requested schema or table does not exist." });
    expect(cached()).toBeUndefined();
  });

  it("keeps connections separate", async () => {
    await useMetadataStore.getState().ensureTables("c1", refs(1));
    expect(useMetadataStore.getState().byConnection["c2"]).toBeUndefined();
  });
});

describe("ensureRelationships", () => {
  it("loads once per connection", async () => {
    await useMetadataStore.getState().ensureRelationships("c1");
    await useMetadataStore.getState().ensureRelationships("c1");
    expect(getRelationships).toHaveBeenCalledTimes(1);
    expect(cached()?.relationships).toEqual([]);
  });

  it("keeps cached tables when relationships arrive", async () => {
    await useMetadataStore.getState().ensureTables("c1", refs(2));
    await useMetadataStore.getState().ensureRelationships("c1");
    expect(Object.keys(cached()?.tables ?? {})).toHaveLength(2);
  });
});

describe("forgetConnection", () => {
  it("drops everything cached for the connection", async () => {
    await useMetadataStore.getState().ensureTables("c1", refs(2));
    useMetadataStore.getState().forgetConnection("c1");
    expect(cached()).toBeUndefined();
  });
});
