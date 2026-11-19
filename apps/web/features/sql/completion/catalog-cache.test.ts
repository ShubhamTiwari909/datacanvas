import type { DatabaseStructure } from "@datacanvas/database-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getLiveStructure = vi.fn();
vi.mock("@/features/snapshots/api", () => ({
  getLiveStructure: (...args: unknown[]) => getLiveStructure(...args),
}));

import { ensureCatalog, forgetCatalog, invalidateCatalog, peekCatalog } from "./catalog-cache";

const structure = (name: string): DatabaseStructure => ({
  schemas: ["public"],
  tables: [
    {
      schema: "public",
      name,
      kind: "table",
      comment: null,
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
      constraints: [],
      indexes: [],
    },
  ],
  relationships: [],
  objects: null,
});
const ok = (name: string) => ({ ok: true, data: structure(name) });

let n = 0;
let id: string;
beforeEach(() => {
  getLiveStructure.mockReset();
  id = `conn-${n++}`;
});

describe("the completion catalog cache", () => {
  it("loads once, keeps names and types only, and answers from memory afterwards", async () => {
    getLiveStructure.mockResolvedValue(ok("users"));
    const first = await ensureCatalog(id);
    expect(first?.relations.map((r) => r.name)).toEqual(["users"]);
    expect(first?.relations[0]?.columns).toEqual([{ name: "id", dataType: "integer" }]);
    expect(await ensureCatalog(id)).toBe(first);
    expect(getLiveStructure).toHaveBeenCalledTimes(1);
    expect(peekCatalog(id)).toBe(first);
  });

  it("shares one load between callers that ask at the same time", async () => {
    getLiveStructure.mockResolvedValue(ok("users"));
    const [a, b] = await Promise.all([ensureCatalog(id), ensureCatalog(id)]);
    expect(a).toBe(b);
    expect(getLiveStructure).toHaveBeenCalledTimes(1);
  });

  it("reads again after the structure changed", async () => {
    getLiveStructure.mockResolvedValueOnce(ok("users")).mockResolvedValueOnce(ok("customers"));
    await ensureCatalog(id);
    invalidateCatalog(id);
    expect(peekCatalog(id)).toBeNull();
    expect((await ensureCatalog(id))?.relations[0]?.name).toBe("customers");
  });

  it("answers null when it cannot be read, and does not ask again at once", async () => {
    getLiveStructure.mockResolvedValue({
      ok: false,
      error: { code: "x", message: "m", issues: [] },
    });
    expect(await ensureCatalog(id)).toBeNull();
    expect(await ensureCatalog(id)).toBeNull();
    expect(getLiveStructure).toHaveBeenCalledTimes(1);
  });

  it("ignores an answer that arrives after the connection was dropped", async () => {
    let finish: (value: unknown) => void = () => {};
    getLiveStructure.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const loading = ensureCatalog(id);
    forgetCatalog(id);
    finish(ok("users"));
    expect(await loading).toBeNull();
    expect(peekCatalog(id)).toBeNull();
  });
});
