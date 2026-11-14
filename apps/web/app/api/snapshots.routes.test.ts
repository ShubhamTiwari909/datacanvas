/**
 * Route tests for structure snapshots: every endpoint, called the way Next.js
 * calls it, against a temporary data folder and a mock adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setServerContextForTests } from "@/lib/server/context";
import { createTestContext, fieldsInput, type TestContext } from "@/lib/server/test-support";
import { POST as createConnection } from "./connections/route";
import { GET as getObjects } from "./connections/[id]/objects/route";
import { GET as getStructure } from "./connections/[id]/structure/route";
import { POST as createSnapshot } from "./connections/[id]/snapshots/route";
import { GET as exportSnapshot } from "./snapshots/[id]/export/route";
import { DELETE as deleteSnapshot, GET as getSnapshot } from "./snapshots/[id]/route";
import { POST as importSnapshot } from "./snapshots/import/route";
import { GET as listSnapshots } from "./snapshots/route";

const BASE = "http://127.0.0.1:4747/api";
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

// Loosely typed on purpose: these tests probe many response shapes (shapes are checked by Zod elsewhere).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function call(
  response: Promise<Response> | Response,
): Promise<{ status: number; body: Json; headers: Headers }> {
  const r = await response;
  const text = await r.text();
  let body: Json;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: r.status, body, headers: r.headers };
}

const json = (url: string, method: string, body: unknown): Request =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

let context: TestContext;
beforeEach(() => {
  context = createTestContext();
  setServerContextForTests(context);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  setServerContextForTests(undefined);
  vi.restoreAllMocks();
});

async function connect(): Promise<string> {
  const { body } = await call(createConnection(json(`${BASE}/connections`, "POST", fieldsInput())));
  return body.connection.id;
}

async function snapshotOf(connectionId: string, name?: string): Promise<Json> {
  const { body } = await call(
    createSnapshot(
      json(`${BASE}/c/snapshots`, "POST", name === undefined ? {} : { name }),
      params({ id: connectionId }),
    ),
  );
  return body.snapshot;
}

describe("GET /connections/:id/structure", () => {
  it("returns the live structure, and saves nothing", async () => {
    const id = await connect();
    const { status, body } = await call(getStructure(new Request(`${BASE}/x`), params({ id })));
    expect(status).toBe(200);
    expect(body.structure.tables.length).toBeGreaterThan(0);
    expect(body.structure.relationships.length).toBeGreaterThan(0);
    expect((await call(listSnapshots(new Request(`${BASE}/snapshots`)))).body.snapshots).toEqual(
      [],
    );
  });

  it("answers 404 for an unknown connection", async () => {
    const { status, body } = await call(
      getStructure(new Request(`${BASE}/x`), params({ id: "missing" })),
    );
    expect(status).toBe(404);
    expect(body.error.code).toBe("connection_not_found");
  });
});

describe("GET /connections/:id/objects", () => {
  it("returns every kind of object, and nothing is saved", async () => {
    const id = await connect();
    const { status, body } = await call(getObjects(new Request(`${BASE}/x`), params({ id })));
    expect(status).toBe(200);
    for (const kind of [
      "views",
      "types",
      "sequences",
      "functions",
      "triggers",
      "extensions",
      "policies",
      "rowSecurity",
    ]) {
      expect(body.objects[kind].length, kind).toBeGreaterThan(0);
    }
    expect(body.objects.views[0].definition).toContain("SELECT");
    expect((await call(listSnapshots(new Request(`${BASE}/snapshots`)))).body.snapshots).toEqual(
      [],
    );
  });

  it("answers 404 for an unknown connection", async () => {
    const { status, body } = await call(
      getObjects(new Request(`${BASE}/x`), params({ id: "missing" })),
    );
    expect(status).toBe(404);
    expect(body.error.code).toBe("connection_not_found");
  });
});

describe("snapshots", () => {
  it("POST creates (201), GET lists summaries, GET :id returns the structure", async () => {
    const id = await connect();
    const created = await call(
      createSnapshot(json(`${BASE}/c/snapshots`, "POST", { name: "Baseline" }), params({ id })),
    );
    expect(created.status).toBe(201);
    expect(created.body.snapshot).toMatchObject({ name: "Baseline" });
    expect(created.body.snapshot.structure).toBeUndefined();

    const list = await call(listSnapshots(new Request(`${BASE}/snapshots`)));
    expect(list.body.snapshots).toHaveLength(1);
    expect(list.body.snapshots[0].id).toBe(created.body.snapshot.id);

    const full = await call(
      getSnapshot(new Request(`${BASE}/x`), params({ id: created.body.snapshot.id })),
    );
    expect(full.status).toBe(200);
    expect(full.body.snapshot.structure.tables.length).toBeGreaterThan(0);
    expect(full.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts no name and makes one", async () => {
    const snapshot = await snapshotOf(await connect());
    expect(snapshot.name).toMatch(/^shop \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("rejects a body with unknown keys or a blank name (400)", async () => {
    const id = await connect();
    for (const body of [{ name: "   " }, { name: "ok", extra: 1 }, { name: 7 }]) {
      const r = await call(
        createSnapshot(json(`${BASE}/c/snapshots`, "POST", body), params({ id })),
      );
      expect(r).toMatchObject({ status: 400, body: { error: { code: "validation_error" } } });
    }
  });

  it("requires a JSON body (415)", async () => {
    const id = await connect();
    const r = await call(
      createSnapshot(new Request(`${BASE}/c/snapshots`, { method: "POST" }), params({ id })),
    );
    expect(r.status).toBe(415);
  });

  it("answers 404 when the connection does not exist", async () => {
    const r = await call(
      createSnapshot(json(`${BASE}/c/snapshots`, "POST", {}), params({ id: "missing" })),
    );
    expect(r).toMatchObject({ status: 404, body: { error: { code: "connection_not_found" } } });
  });

  it("DELETE removes it; a second DELETE and an unknown GET answer 404", async () => {
    const { id } = await snapshotOf(await connect());
    const first = await call(
      deleteSnapshot(new Request(`${BASE}/x`, { method: "DELETE" }), params({ id })),
    );
    expect(first).toMatchObject({ status: 200, body: { ok: true } });
    const again = await call(
      deleteSnapshot(new Request(`${BASE}/x`, { method: "DELETE" }), params({ id })),
    );
    expect(again).toMatchObject({ status: 404, body: { error: { code: "snapshot_not_found" } } });
    const get = await call(getSnapshot(new Request(`${BASE}/x`), params({ id })));
    expect(get.status).toBe(404);
  });

  it("a path-like id is a plain 404, never a file read", async () => {
    const r = await call(
      getSnapshot(new Request(`${BASE}/x`), params({ id: "../../profiles/index" })),
    );
    expect(r).toMatchObject({ status: 404, body: { error: { code: "snapshot_not_found" } } });
  });
});

describe("export and import", () => {
  it("exports a download with a safe name and imports it as a new snapshot", async () => {
    const connectionId = await connect();
    const original = await snapshotOf(connectionId, 'Q4 "final"/v2');

    const exported = await exportSnapshot(new Request(`${BASE}/x`), params({ id: original.id }));
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toBe(
      'attachment; filename="Q4 _final__v2.snapshot.json"',
    );
    const file = JSON.parse(await exported.text());
    expect(file).toMatchObject({ format: "datacanvas-snapshot", schemaVersion: 2 });

    const imported = await call(importSnapshot(json(`${BASE}/snapshots/import`, "POST", file)));
    expect(imported.status).toBe(201);
    expect(imported.body.snapshot.id).not.toBe(original.id);
    expect(imported.body.snapshot.counts).toEqual(original.counts);
  });

  it("refuses a damaged or foreign file (400) without echoing it", async () => {
    const r = await call(
      importSnapshot(json(`${BASE}/snapshots/import`, "POST", { secret: "do-not-echo" })),
    );
    expect(r).toMatchObject({ status: 400, body: { error: { code: "invalid_snapshot_file" } } });
    expect(JSON.stringify(r.body)).not.toContain("do-not-echo");
  });
});

describe("no secrets", () => {
  it("never puts the password in any snapshot response", async () => {
    const connectionId = await connect();
    const { id } = await snapshotOf(connectionId);
    const responses = [
      await call(getStructure(new Request(`${BASE}/x`), params({ id: connectionId }))),
      await call(listSnapshots(new Request(`${BASE}/snapshots`))),
      await call(getSnapshot(new Request(`${BASE}/x`), params({ id }))),
    ];
    const exported = await (await exportSnapshot(new Request(`${BASE}/x`), params({ id }))).text();
    for (const text of [...responses.map((r) => JSON.stringify(r.body)), exported]) {
      expect(text).not.toContain("s3cret-pw");
    }
  });
});
