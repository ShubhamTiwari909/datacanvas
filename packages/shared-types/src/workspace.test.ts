import { describe, expect, it } from "vitest";
import {
  MAX_WORKSPACE_NODES,
  parseWorkspaceFile,
  summarizeWorkspace,
  toExportedWorkspace,
  workspaceInputSchema,
  type Workspace,
} from "./workspace.js";

const workspace: Workspace = {
  format: "datacanvas-workspace",
  schemaVersion: 1,
  id: "ws-abcdef12",
  name: "Orders layout",
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T11:30:00.000Z",
  profileId: "profile-12345678",
  connectionHint: { connectionName: "Shop", database: "shop" },
  canvas: {
    nodes: [
      { schema: "public", name: "orders", x: 10.5, y: -20, expanded: false },
      { schema: "public", name: "users", x: 400, y: 0, expanded: true },
    ],
    viewport: { x: 12, y: 34, zoom: 0.75 },
  },
};

describe("parseWorkspaceFile", () => {
  it("accepts a valid workspace and returns it unchanged", () => {
    expect(parseWorkspaceFile(workspace)).toEqual({ ok: true, workspace });
  });

  it("round-trips through JSON text exactly (what happens when it is saved and loaded)", () => {
    const loaded = parseWorkspaceFile(JSON.parse(JSON.stringify(workspace)));
    expect(loaded).toEqual({ ok: true, workspace });
  });

  it("accepts a workspace with no viewport and no profile", () => {
    const bare = {
      ...workspace,
      profileId: null,
      connectionHint: null,
      canvas: { nodes: [], viewport: null },
    };
    expect(parseWorkspaceFile(bare).ok).toBe(true);
  });

  it("strips unknown top-level keys instead of failing (forward compatibility within a version)", () => {
    const result = parseWorkspaceFile({ ...workspace, somethingNew: 1 });
    expect(result.ok && result.workspace).not.toHaveProperty("somethingNew");
  });

  it("refuses a file from a newer release", () => {
    const result = parseWorkspaceFile({ ...workspace, schemaVersion: 2 });
    expect(result).toMatchObject({ ok: false, code: "invalid_workspace_file" });
    expect(!result.ok && result.message).toMatch(/newer version/);
  });

  it.each([
    ["something that is not a workspace", { format: "datacanvas-connections", schemaVersion: 1 }],
    ["plain text", "hello"],
    ["a missing name", { ...workspace, name: undefined }],
    ["a blank name", { ...workspace, name: "   " }],
    ["an unsafe id", { ...workspace, id: "../../etc/passwd" }],
    ["a malformed date", { ...workspace, createdAt: "yesterday" }],
    [
      "a node with a non-numeric position",
      {
        ...workspace,
        canvas: {
          nodes: [{ schema: "public", name: "a", x: "1", y: 0, expanded: false }],
          viewport: null,
        },
      },
    ],
    [
      "a node with an absurd coordinate",
      {
        ...workspace,
        canvas: {
          nodes: [{ schema: "public", name: "a", x: 1e12, y: 0, expanded: false }],
          viewport: null,
        },
      },
    ],
    [
      "a node with an unknown key",
      {
        ...workspace,
        canvas: {
          nodes: [{ schema: "public", name: "a", x: 0, y: 0, expanded: false, extra: true }],
          viewport: null,
        },
      },
    ],
    ["a zero zoom", { ...workspace, canvas: { nodes: [], viewport: { x: 0, y: 0, zoom: 0 } } }],
  ])("rejects %s", (_label, input) => {
    expect(parseWorkspaceFile(input)).toMatchObject({ ok: false, code: "invalid_workspace_file" });
  });

  it("rejects more nodes than the limit", () => {
    const nodes = Array.from({ length: MAX_WORKSPACE_NODES + 1 }, (_v, i) => ({
      schema: "public",
      name: `t${i}`,
      x: 0,
      y: 0,
      expanded: false,
    }));
    expect(parseWorkspaceFile({ ...workspace, canvas: { nodes, viewport: null } }).ok).toBe(false);
  });

  it("points at the damaged part without echoing its value", () => {
    const result = parseWorkspaceFile({ ...workspace, name: 12345678901234 });
    expect(!result.ok && result.message).toMatch(/damaged or incomplete \(problem at "name"\)/);
    expect(JSON.stringify(result)).not.toContain("12345678901234");
  });
});

describe("workspaceInputSchema", () => {
  const input = {
    name: "Layout",
    profileId: null,
    connectionHint: null,
    canvas: { nodes: [], viewport: null },
  };

  it("accepts what a client saves", () => {
    expect(workspaceInputSchema.safeParse(input).success).toBe(true);
  });

  it("does not let a client choose the id or the timestamps", () => {
    expect(workspaceInputSchema.safeParse({ ...input, id: "mine-12345678" }).success).toBe(false);
    expect(
      workspaceInputSchema.safeParse({ ...input, updatedAt: "2026-01-01T00:00:00.000Z" }).success,
    ).toBe(false);
  });

  it("trims the name and rejects an empty one", () => {
    expect(workspaceInputSchema.parse({ ...input, name: "  Tidy  " }).name).toBe("Tidy");
    expect(workspaceInputSchema.safeParse({ ...input, name: " " }).success).toBe(false);
  });
});

describe("summaries and exports", () => {
  it("summarises without the canvas contents", () => {
    expect(summarizeWorkspace(workspace)).toEqual({
      id: "ws-abcdef12",
      name: "Orders layout",
      updatedAt: "2026-11-13T11:30:00.000Z",
      profileId: "profile-12345678",
      tableCount: 2,
    });
  });

  it("drops the machine-specific profile id from an exported file, and the export is still a valid workspace", () => {
    const exported = toExportedWorkspace(workspace);
    expect(exported.profileId).toBeNull();
    expect(exported.connectionHint).toEqual(workspace.connectionHint);
    expect(parseWorkspaceFile(exported).ok).toBe(true);
  });
});
