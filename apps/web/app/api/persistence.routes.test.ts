/**
 * Route tests for saved connections and workspaces: every endpoint, called the
 * way Next.js calls it, against temporary data folders and mock adapters.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setServerContextForTests } from "@/lib/server/context";
import { createTestContext, fieldsInput, type TestContext } from "@/lib/server/test-support";
import { POST as saveConnection } from "./connections/[id]/save/route";
import { POST as createConnection } from "./connections/route";
import { DELETE as deleteProfile } from "./profiles/[id]/route";
import { GET as listProfiles } from "./profiles/route";
import { GET as exportWorkspace } from "./workspaces/[id]/export/route";
import {
  DELETE as deleteWorkspace,
  GET as getWorkspace,
  PUT as putWorkspace,
} from "./workspaces/[id]/route";
import { POST as importWorkspace } from "./workspaces/import/route";
import { GET as listWorkspaces } from "./workspaces/route";

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

const canvas = {
  nodes: [{ schema: "public", name: "users", x: 1, y: 2, expanded: false }],
  viewport: { x: 0, y: 0, zoom: 1 },
};
const workspaceBody = (overrides: Record<string, unknown> = {}) => ({
  name: "Layout",
  profileId: null,
  connectionHint: null,
  canvas,
  ...overrides,
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

/** Connect with remember=true and return the live connection and its saved profile id. */
async function connectAndRemember(): Promise<{ connectionId: string; profileId: string }> {
  const { body } = await call(
    createConnection(json(`${BASE}/connections`, "POST", fieldsInput({ remember: true }))),
  );
  return { connectionId: body.connection.id, profileId: body.connection.profileId };
}

describe("profiles", () => {
  it("lists nothing at first", async () => {
    expect((await call(listProfiles())).body).toEqual({ profiles: [] });
  });

  it("remember on connect saves a profile that the API lists, without a password", async () => {
    const { profileId } = await connectAndRemember();
    const { status, body } = await call(listProfiles());
    expect(status).toBe(200);
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0]).toMatchObject({
      id: profileId,
      name: "Shop",
      host: "localhost",
      database: "shop",
    });
    expect(JSON.stringify(body)).not.toContain("s3cret-pw");
  });

  it("POST /connections/:id/save saves a connection opened without remembering", async () => {
    const created = await call(
      createConnection(json(`${BASE}/connections`, "POST", fieldsInput())),
    );
    expect(created.body.connection.profileId).toBeNull();

    const saved = await call(
      saveConnection(
        new Request(`${BASE}/x`, { method: "POST" }),
        params({ id: created.body.connection.id }),
      ),
    );

    expect(saved.status).toBe(200);
    expect(saved.body.connection.profileId).toBeTruthy();
    expect((await call(listProfiles())).body.profiles).toHaveLength(1);
  });

  it("answers 404 for an unknown connection or profile", async () => {
    const save = await call(
      saveConnection(new Request(`${BASE}/x`, { method: "POST" }), params({ id: "nope" })),
    );
    expect(save).toMatchObject({ status: 404, body: { error: { code: "connection_not_found" } } });
    const del = await call(
      deleteProfile(
        new Request(`${BASE}/x`, { method: "DELETE" }),
        params({ id: "profile-missing1" }),
      ),
    );
    expect(del).toMatchObject({ status: 404, body: { error: { code: "profile_not_found" } } });
  });

  it("DELETE forgets the profile and its workspaces", async () => {
    const { profileId } = await connectAndRemember();
    await call(
      putWorkspace(
        json(`${BASE}/w`, "PUT", workspaceBody({ profileId })),
        params({ id: "ws-aaaaaaaa" }),
      ),
    );

    const { status } = await call(
      deleteProfile(new Request(`${BASE}/x`, { method: "DELETE" }), params({ id: profileId })),
    );

    expect(status).toBe(200);
    expect((await call(listProfiles())).body.profiles).toEqual([]);
    expect((await call(listWorkspaces(new Request(`${BASE}/workspaces`)))).body.workspaces).toEqual(
      [],
    );
  });
});

describe("workspaces", () => {
  it("PUT creates, GET reads back, and the server stamps the timestamps", async () => {
    const put = await call(
      putWorkspace(json(`${BASE}/w`, "PUT", workspaceBody()), params({ id: "ws-aaaaaaaa" })),
    );
    expect(put.status).toBe(200);
    expect(put.body.workspace).toMatchObject({
      id: "ws-aaaaaaaa",
      name: "Layout",
      schemaVersion: 1,
    });
    expect(put.body.workspace.createdAt).toBeTruthy();

    const get = await call(getWorkspace(new Request(`${BASE}/w`), params({ id: "ws-aaaaaaaa" })));
    expect(get.body.workspace).toEqual(put.body.workspace);
  });

  it("lists summaries and can filter by saved connection", async () => {
    const { profileId } = await connectAndRemember();
    await call(
      putWorkspace(
        json(`${BASE}/w`, "PUT", workspaceBody({ profileId, name: "Mine" })),
        params({ id: "ws-aaaaaaaa" }),
      ),
    );
    await call(
      putWorkspace(
        json(`${BASE}/w`, "PUT", workspaceBody({ name: "Other" })),
        params({ id: "ws-bbbbbbbb" }),
      ),
    );

    const all = await call(listWorkspaces(new Request(`${BASE}/workspaces`)));
    const mine = await call(
      listWorkspaces(new Request(`${BASE}/workspaces?profileId=${profileId}`)),
    );

    expect(all.body.workspaces).toHaveLength(2);
    expect(mine.body.workspaces).toMatchObject([{ name: "Mine", tableCount: 1 }]);
    expect(mine.body.workspaces[0]).not.toHaveProperty("canvas");
  });

  it("rejects an invalid filter", async () => {
    const result = await call(listWorkspaces(new Request(`${BASE}/workspaces?profileId=../x`)));
    expect(result).toMatchObject({ status: 400, body: { error: { code: "validation_error" } } });
  });

  it("DELETE removes it; a second delete and a GET are 404", async () => {
    await call(
      putWorkspace(json(`${BASE}/w`, "PUT", workspaceBody()), params({ id: "ws-aaaaaaaa" })),
    );
    expect(
      (
        await call(
          deleteWorkspace(
            new Request(`${BASE}/w`, { method: "DELETE" }),
            params({ id: "ws-aaaaaaaa" }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          deleteWorkspace(
            new Request(`${BASE}/w`, { method: "DELETE" }),
            params({ id: "ws-aaaaaaaa" }),
          ),
        )
      ).status,
    ).toBe(404);
    const get = await call(getWorkspace(new Request(`${BASE}/w`), params({ id: "ws-aaaaaaaa" })));
    expect(get).toMatchObject({ status: 404, body: { error: { code: "workspace_not_found" } } });
  });

  describe("validation", () => {
    const put = (body: unknown, id = "ws-aaaaaaaa") =>
      call(putWorkspace(json(`${BASE}/w`, "PUT", body), params({ id })));

    it("rejects hostile ids before touching the disk", async () => {
      for (const id of ["../../etc/passwd", "..", "a/b", "short", "x".repeat(65)]) {
        const result = await put(workspaceBody(), id);
        expect(result.status, id).toBe(400);
      }
      expect(await import("node:fs/promises").then((fs) => fs.readdir(context.dataDir))).toEqual(
        [],
      );
    });

    it("rejects a body with an id, timestamps or unknown fields (the server owns those)", async () => {
      expect((await put({ ...workspaceBody(), id: "mine-12345678" })).status).toBe(400);
      expect(
        (await put({ ...workspaceBody(), updatedAt: "2026-01-01T00:00:00.000Z" })).status,
      ).toBe(400);
    });

    it("reports which fields are wrong", async () => {
      const result = await put({
        name: "",
        profileId: null,
        connectionHint: null,
        canvas: {
          nodes: [{ schema: "p", name: "t", x: "1", y: 0, expanded: false }],
          viewport: null,
        },
      });
      expect(result.status).toBe(400);
      expect(result.body.error.issues.map((i: { path: string }) => i.path)).toEqual(
        expect.arrayContaining(["name", "canvas.nodes.0.x"]),
      );
    });

    it("rejects a layout for a saved connection that does not exist", async () => {
      const result = await put(workspaceBody({ profileId: "profile-missing1" }));
      expect(result).toMatchObject({ status: 404, body: { error: { code: "profile_not_found" } } });
    });

    it("requires JSON", async () => {
      const result = await call(
        putWorkspace(
          new Request(`${BASE}/w`, {
            method: "PUT",
            headers: { "Content-Type": "text/plain" },
            body: "x",
          }),
          params({ id: "ws-aaaaaaaa" }),
        ),
      );
      expect(result.status).toBe(415);
    });
  });

  describe("export and import", () => {
    it("exports a downloadable file with a safe name and no machine-specific link", async () => {
      const { profileId } = await connectAndRemember();
      await call(
        putWorkspace(
          json(`${BASE}/w`, "PUT", workspaceBody({ profileId, name: "Q4 plan" })),
          params({ id: "ws-aaaaaaaa" }),
        ),
      );

      const result = await call(
        exportWorkspace(new Request(`${BASE}/w`), params({ id: "ws-aaaaaaaa" })),
      );

      expect(result.status).toBe(200);
      expect(result.headers.get("Content-Disposition")).toBe(
        'attachment; filename="Q4 plan.datacanvas.json"',
      );
      expect(result.body).toMatchObject({
        format: "datacanvas-workspace",
        schemaVersion: 1,
        name: "Q4 plan",
        profileId: null,
      });
    });

    it("import creates a new workspace attached to the chosen connection (201)", async () => {
      const { profileId } = await connectAndRemember();
      await call(
        putWorkspace(json(`${BASE}/w`, "PUT", workspaceBody()), params({ id: "ws-aaaaaaaa" })),
      );
      const exported = await call(
        exportWorkspace(new Request(`${BASE}/w`), params({ id: "ws-aaaaaaaa" })),
      );

      const imported = await call(
        importWorkspace(
          json(`${BASE}/workspaces/import?profileId=${profileId}`, "POST", exported.body),
        ),
      );

      expect(imported.status).toBe(201);
      expect(imported.body.workspace.id).not.toBe("ws-aaaaaaaa");
      expect(imported.body.workspace).toMatchObject({ profileId, name: "Layout" });
      expect(
        (await call(listWorkspaces(new Request(`${BASE}/workspaces`)))).body.workspaces,
      ).toHaveLength(2);
    });

    it("rejects files that are not workspaces, files from newer releases, and damaged files", async () => {
      for (const bad of [
        { hello: "world" },
        "text",
        { format: "datacanvas-workspace", schemaVersion: 99 },
        { format: "datacanvas-workspace", schemaVersion: 1, name: 5 },
      ]) {
        const result = await call(importWorkspace(json(`${BASE}/workspaces/import`, "POST", bad)));
        expect(result.status).toBe(400);
        expect(result.body.error.code).toBe("invalid_workspace_file");
      }
    });

    it("rejects an oversized import", async () => {
      const huge = {
        format: "datacanvas-workspace",
        schemaVersion: 1,
        pad: "x".repeat(1024 * 1024 + 10),
      };
      expect(
        (await call(importWorkspace(json(`${BASE}/workspaces/import`, "POST", huge)))).status,
      ).toBe(413);
    });
  });
});
