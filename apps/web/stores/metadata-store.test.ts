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

describe("refreshAfterChange", () => {
  const withComment = (name: string, comment: string): TableDetailsEntry => {
    const e = entry(name);
    return { ...e, table: { ...e.table, comment } };
  };
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const t0 = { schema: "public", name: "t0" };
  const t1 = { schema: "public", name: "t1" };
  const key = (name: string) => JSON.stringify(["public", name]);
  const KEY0 = key("t0");
  const comment = (name: string) => cached()?.tables[key(name)]?.table.comment;
  const fail = (): ApiResult<never> => ({
    ok: false,
    error: { code: "unreachable", message: "No answer.", issues: [] },
  });

  it("an older answer cannot overwrite a newer one for the same table", async () => {
    await useMetadataStore.getState().ensureTables("c1", [t0]);
    const slow = deferred<ApiResult<TableDetailsEntry[]>>();
    getTablesDetails.mockReturnValueOnce(slow.promise);
    getTablesDetails.mockResolvedValueOnce(ok([withComment("t0", "v2")]));

    const older = useMetadataStore.getState().refreshAfterChange("c1", { reload: [t0], drop: [] });
    await useMetadataStore.getState().refreshAfterChange("c1", { reload: [t0], drop: [] });
    expect(comment("t0")).toBe("v2");
    slow.resolve(ok([withComment("t0", "v1")])); // arrives last
    await older;
    expect(comment("t0")).toBe("v2");
  });

  it("different tables do not hold each other back", async () => {
    await useMetadataStore.getState().ensureTables("c1", [t0, t1]);
    const slow = deferred<ApiResult<TableDetailsEntry[]>>();
    getTablesDetails.mockReturnValueOnce(slow.promise);
    getTablesDetails.mockResolvedValueOnce(ok([withComment("t1", "new1")]));

    const first = useMetadataStore.getState().refreshAfterChange("c1", { reload: [t0], drop: [] });
    await useMetadataStore.getState().refreshAfterChange("c1", { reload: [t1], drop: [] });
    slow.resolve(ok([withComment("t0", "new0")]));
    await first;
    expect([comment("t0"), comment("t1")]).toEqual(["new0", "new1"]);
  });

  it("a read of a table that began before a drop cannot bring it back", async () => {
    const slow = deferred<ApiResult<TableDetailsEntry[]>>();
    getTablesDetails.mockReturnValueOnce(slow.promise);
    const ensuring = useMetadataStore.getState().ensureTables("c1", [t0]);
    await useMetadataStore.getState().refreshAfterChange("c1", { reload: [], drop: [t0] });
    slow.resolve(ok([entry("t0")]));
    await ensuring;
    expect(cached()?.tables[KEY0]).toBeUndefined();
  });

  it("a failed refresh keeps the old copy but the next ensure reads it again", async () => {
    await useMetadataStore.getState().ensureTables("c1", [t0]);
    getTablesDetails.mockResolvedValueOnce(fail());
    const result = await useMetadataStore
      .getState()
      .refreshAfterChange("c1", { reload: [t0], drop: [] });
    expect(result).toEqual({ ok: false, message: "No answer." });
    expect(cached()?.tables[KEY0]).toBeDefined(); // no gap on the canvas
    expect(cached()?.staleTables).toEqual({ [KEY0]: true });

    getTablesDetails.mockResolvedValueOnce(ok([withComment("t0", "healed")]));
    await useMetadataStore.getState().ensureTables("c1", [t0]);
    expect(comment("t0")).toBe("healed");
    expect(cached()?.staleTables).toEqual({});
    // And once healed it is not read again.
    getTablesDetails.mockClear();
    await useMetadataStore.getState().ensureTables("c1", [t0]);
    expect(getTablesDetails).not.toHaveBeenCalled();
  });

  it("a failed refresh of the relationships is retried by the next ensure", async () => {
    await useMetadataStore.getState().ensureRelationships("c1");
    getRelationships.mockResolvedValueOnce(fail());
    await useMetadataStore.getState().refreshAfterChange("c1", { reload: [], drop: [] });
    expect(cached()?.relationshipsStale).toBe(true);
    expect(cached()?.relationships).toEqual([]); // still shown

    getRelationships.mockClear();
    await useMetadataStore.getState().ensureRelationships("c1");
    expect(getRelationships).toHaveBeenCalledTimes(1);
    expect(cached()?.relationshipsStale).toBe(false);
  });
});

describe("forgetConnection", () => {
  it("drops everything cached for the connection", async () => {
    await useMetadataStore.getState().ensureTables("c1", refs(2));
    useMetadataStore.getState().forgetConnection("c1");
    expect(cached()).toBeUndefined();
  });
});
