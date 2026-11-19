import type { DatabaseStructure } from "@datacanvas/database-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "@/lib/api-client";
import { compareSides, sideValue } from "./compare";

vi.mock("./api", () => ({ getLiveStructure: vi.fn(), getSnapshot: vi.fn() }));
import { getLiveStructure, getSnapshot } from "./api";

const table = (name: string) => ({
  schema: "public",
  name,
  kind: "table" as const,
  comment: null,
  columns: [],
  constraints: [],
  indexes: [],
});
const structure = (...names: string[]): DatabaseStructure => ({
  schemas: ["public"],
  tables: names.map(table),
  relationships: [],
  objects: null,
  ddl: null,
});

const snapshotSide = { kind: "snapshot", id: "snap-aaaaaaaa", label: "Baseline" } as const;
const liveSide = { kind: "live", connectionId: "c1", label: "Live: shop" } as const;
const failure: ApiResult<never> = {
  ok: false,
  error: { code: "network_error", message: "down", issues: [] },
};

beforeEach(() => vi.resetAllMocks());

describe("compareSides", () => {
  it("diffs a snapshot against the live database", async () => {
    vi.mocked(getSnapshot).mockResolvedValue({
      ok: true,
      data: { structure: structure("users") } as never,
    });
    vi.mocked(getLiveStructure).mockResolvedValue({ ok: true, data: structure("users", "orders") });

    const result = await compareSides(snapshotSide, liveSide);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.before).toBe("Baseline");
    expect(result.data.after).toBe("Live: shop");
    expect(result.data.diff.tables.map((t) => [t.name, t.status])).toEqual([["orders", "added"]]);
  });

  it("reports no difference for identical structures", async () => {
    vi.mocked(getLiveStructure).mockResolvedValue({ ok: true, data: structure("users") });
    const result = await compareSides(liveSide, { ...liveSide, connectionId: "c2" });
    expect(result.ok && result.data.diff.isEmpty).toBe(true);
  });

  it("returns the failure of either side instead of a partial diff", async () => {
    vi.mocked(getSnapshot).mockResolvedValue(failure);
    vi.mocked(getLiveStructure).mockResolvedValue({ ok: true, data: structure() });
    expect(await compareSides(snapshotSide, liveSide)).toEqual(failure);

    vi.mocked(getSnapshot).mockResolvedValue({
      ok: true,
      data: { structure: structure() } as never,
    });
    vi.mocked(getLiveStructure).mockResolvedValue(failure);
    expect(await compareSides(snapshotSide, liveSide)).toEqual(failure);
  });
});

describe("sideValue", () => {
  it("tells snapshots and live connections apart", () => {
    expect(sideValue(snapshotSide)).toBe("snapshot:snap-aaaaaaaa");
    expect(sideValue(liveSide)).toBe("live:c1");
  });
});
