import { tableRefKey, type TableDetailsEntry } from "@datacanvas/database-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "@/lib/api-client";
import { loadHealth } from "./load-health";

vi.mock("@/features/explorer/api", () => ({ getIndexUsage: vi.fn() }));
vi.mock("@/features/explorer/load-all-tables", () => ({ loadAllTables: vi.fn() }));
vi.mock("@/stores/metadata-store", () => ({ useMetadataStore: { getState: vi.fn() } }));

import { getIndexUsage } from "@/features/explorer/api";
import { loadAllTables } from "@/features/explorer/load-all-tables";
import { useMetadataStore } from "@/stores/metadata-store";

const entry = (name: string): TableDetailsEntry => ({
  table: { schema: "public", name, kind: "table", comment: null, estimatedRowCount: 10 },
  columns: [
    {
      name: "id",
      ordinalPosition: 1,
      dataType: "integer",
      nullable: false,
      defaultValue: null,
      comment: null,
    },
  ],
  constraints: [], // no primary key, so the structural checks have something to report
  indexes: [],
});

const failure: ApiResult<never> = {
  ok: false,
  error: { code: "permission_denied", message: "no access to statistics", issues: [] },
};

function arrange() {
  const tables = [entry("loose")];
  vi.mocked(loadAllTables).mockResolvedValue({
    ok: true,
    data: [{ schema: "public", tables: tables.map((e) => e.table) }],
  } as never);
  vi.mocked(useMetadataStore.getState).mockReturnValue({
    ensureTables: async () => ({ ok: true }),
    ensureRelationships: async () => ({ ok: true }),
    byConnection: {
      c1: {
        tables: Object.fromEntries(
          tables.map((e) => [tableRefKey({ schema: e.table.schema, name: e.table.name }), e]),
        ),
        relationships: [],
      },
    },
  } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  arrange();
});

describe("loadHealth", () => {
  it("still returns the structural findings when the usage counters cannot be read", async () => {
    vi.mocked(getIndexUsage).mockResolvedValue(failure);

    const result = await loadHealth("c1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.usageProblem).toBe("no access to statistics");
    expect(result.data.usage).toBeNull();
    expect(result.data.findings.map((f) => f.check)).toContain("no_primary_key");
  });

  it("reports what the usage was based on when it can be read", async () => {
    vi.mocked(getIndexUsage).mockResolvedValue({
      ok: true,
      data: { statsReset: "2026-10-01T00:00:00.000Z", inRecovery: false, indexes: [] },
    });

    const result = await loadHealth("c1");

    expect(result.ok && result.data.usageProblem).toBeNull();
    expect(result.ok && result.data.usage).toEqual({
      statsReset: "2026-10-01T00:00:00.000Z",
      inRecovery: false,
      indexes: 0,
    });
  });

  it("asks for the usage counters at the same time as the tables, not after them", async () => {
    let release: (value: never) => void = () => {};
    vi.mocked(loadAllTables).mockReturnValue(
      new Promise((resolve) => (release = resolve as never)),
    );
    vi.mocked(getIndexUsage).mockResolvedValue(failure);

    const pending = loadHealth("c1");
    await Promise.resolve();
    // The tables are still loading, and the usage request has already gone out.
    expect(getIndexUsage).toHaveBeenCalledTimes(1);

    arrange();
    release({ ok: true, data: [] } as never);
    await pending;
  });

  it("returns the failure when the tables cannot be listed", async () => {
    vi.mocked(getIndexUsage).mockResolvedValue(failure);
    vi.mocked(loadAllTables).mockResolvedValue(failure);
    expect(await loadHealth("c1")).toEqual(failure);
  });
});
