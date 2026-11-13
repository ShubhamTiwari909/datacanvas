/**
 * Contracts for saved WORKSPACES and the files they are stored in.
 *
 * A workspace remembers a canvas LAYOUT: which tables are on it, where, whether
 * each is expanded, and the pan and zoom. It deliberately does NOT contain:
 *   - credentials (never written to disk),
 *   - database structure (columns, types: it would go stale; it is re-read),
 *   - selection (a moment-to-moment UI state).
 *
 * File format (version 1), one JSON file per workspace:
 *   { "format": "datacanvas-workspace", "schemaVersion": 1, "id", "name",
 *     "createdAt", "updatedAt", "profileId", "connectionHint",
 *     "canvas": { "nodes": [{ "schema", "name", "x", "y", "expanded" }], "viewport" } }
 */
import { z } from "zod";
import { identifierSchema } from "./connections.js";
import { workspaceIdSchema, profileIdSchema } from "./ids.js";
import { migrateToCurrent, type Migration } from "./versioned-file.js";

export const WORKSPACE_FORMAT = "datacanvas-workspace";
export const CURRENT_WORKSPACE_VERSION = 1;

/** Bounds, so a hand-edited or hostile file cannot make us allocate without limit. */
export const MAX_WORKSPACE_NODES = 2000;
const COORDINATE_LIMIT = 1e7;

const coordinate = z.number().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT);

/** One table on the canvas. Positions are in canvas space (see canvas-engine). */
export const savedNodeSchema = z.strictObject({
  schema: identifierSchema,
  name: identifierSchema,
  x: coordinate,
  y: coordinate,
  expanded: z.boolean(),
});
export type SavedNode = z.infer<typeof savedNodeSchema>;

/** Pan and zoom of the canvas: `screen = canvas * zoom + (x, y)`. */
export const savedViewportSchema = z.strictObject({
  x: coordinate,
  y: coordinate,
  zoom: z.number().min(0.01).max(10),
});
export type SavedViewport = z.infer<typeof savedViewportSchema>;

export const workspaceCanvasSchema = z.strictObject({
  nodes: z.array(savedNodeSchema).max(MAX_WORKSPACE_NODES),
  viewport: savedViewportSchema.nullable(),
});
export type WorkspaceCanvas = z.infer<typeof workspaceCanvasSchema>;

const workspaceNameSchema = z.string().trim().min(1, "Give the workspace a name.").max(100);

/**
 * Display-only hint about which database the layout was made for, so that an
 * imported file can say "made for orders_db" even on a machine that has no
 * such connection. It is never used to connect to anything.
 */
export const connectionHintSchema = z.strictObject({
  connectionName: z.string().max(100),
  database: z.string().max(63),
});
export type ConnectionHint = z.infer<typeof connectionHintSchema>;

/** What a client sends to create or update a workspace. The server adds ids and timestamps. */
export const workspaceInputSchema = z.strictObject({
  name: workspaceNameSchema,
  /** The saved connection this layout belongs to, or null if it is not attached to one. */
  profileId: profileIdSchema.nullable(),
  connectionHint: connectionHintSchema.nullable(),
  canvas: workspaceCanvasSchema,
});
export type WorkspaceInput = z.infer<typeof workspaceInputSchema>;

/** The complete stored workspace (version 1). Unknown keys are stripped (see decisions). */
export const workspaceSchema = z.object({
  format: z.literal(WORKSPACE_FORMAT),
  schemaVersion: z.literal(CURRENT_WORKSPACE_VERSION),
  id: workspaceIdSchema,
  name: workspaceNameSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  profileId: profileIdSchema.nullable(),
  connectionHint: connectionHintSchema.nullable(),
  canvas: workspaceCanvasSchema,
});
export type Workspace = z.infer<typeof workspaceSchema>;

/** What the workspace list shows: no canvas contents. */
export const workspaceSummarySchema = z.object({
  id: workspaceIdSchema,
  name: z.string(),
  updatedAt: z.string(),
  profileId: profileIdSchema.nullable(),
  tableCount: z.number().int().nonnegative(),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const workspaceResponseSchema = z.object({ workspace: workspaceSchema });
export const listWorkspacesResponseSchema = z.object({
  workspaces: z.array(workspaceSummarySchema),
});

/** Query string of `GET /api/workspaces`. */
export const workspaceListQuerySchema = z.object({ profileId: profileIdSchema.optional() });

export function summarizeWorkspace(workspace: Workspace): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    updatedAt: workspace.updatedAt,
    profileId: workspace.profileId,
    tableCount: workspace.canvas.nodes.length,
  };
}

/**
 * Migrations from older workspace versions. Empty while version 1 is the only
 * version; when version 2 exists, `1: (data) => ({ ...data, ... })` goes here.
 */
export const WORKSPACE_MIGRATIONS: Readonly<Record<number, Migration>> = {};

export type ParsedWorkspaceFile =
  | { ok: true; workspace: Workspace }
  | { ok: false; code: "invalid_workspace_file"; message: string };

/**
 * Read a workspace from untrusted JSON (a file on disk, or an import): upgrade
 * it to the current version, then validate it. The message never echoes the
 * file's content.
 */
export function parseWorkspaceFile(raw: unknown): ParsedWorkspaceFile {
  const migrated = migrateToCurrent(raw, {
    format: WORKSPACE_FORMAT,
    current: CURRENT_WORKSPACE_VERSION,
    migrations: WORKSPACE_MIGRATIONS,
  });
  if (!migrated.ok) return { ok: false, code: "invalid_workspace_file", message: migrated.message };

  const parsed = workspaceSchema.safeParse(migrated.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue && issue.path.length > 0 ? ` (problem at "${issue.path.slice(0, 3).join(".")}")` : "";
    return {
      ok: false,
      code: "invalid_workspace_file",
      message: `The workspace file is damaged or incomplete${where}.`,
    };
  }
  return { ok: true, workspace: parsed.data };
}

/** Build the file content that is handed to the user when they export a workspace. */
export function toExportedWorkspace(workspace: Workspace): Workspace {
  // The profile id only means something on this machine, so it is dropped.
  return { ...workspace, profileId: null };
}
