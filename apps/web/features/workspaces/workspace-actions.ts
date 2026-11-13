/**
 * What the user can DO with workspaces: open the saved one when a connection
 * is opened, switch, create, rename, delete, export, import, and save the
 * connection so layouts can be kept.
 *
 * Every action returns `{ ok: true }` or `{ ok: false, message }` (never throws)
 * and reports progress through the stores, so the menu components stay thin.
 */
import { saveConnection } from "@/features/connections/api";
import { useCanvasStore } from "@/stores/canvas-store";
import { usePersistenceStore } from "@/stores/persistence-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { deleteWorkspace, exportUrl, getWorkspace, importWorkspace, listWorkspaces } from "./api";
import { autosaver } from "./autosave-instance";
import { restoreWorkspace } from "./restore";

export type ActionResult = { ok: true } | { ok: false; message: string };

const profileIdOf = (connectionId: string): string | null =>
  useWorkspaceStore.getState().connections.find((c) => c.id === connectionId)?.profileId ?? null;

/** Open a workspace's layout on the connection's canvas. */
export async function openWorkspace(
  connectionId: string,
  workspaceId: string,
): Promise<ActionResult> {
  const persistence = usePersistenceStore.getState();
  // Save what is on screen first, so switching never loses the current layout.
  await autosaver.flush(connectionId);

  const loaded = await getWorkspace(workspaceId);
  if (!loaded.ok) return { ok: false, message: loaded.error.message };

  const restored = await restoreWorkspace(connectionId, loaded.data);
  if (!restored.ok) return { ok: false, message: restored.message };

  persistence.setActive(connectionId, { id: loaded.data.id, name: loaded.data.name });
  persistence.setNotice(
    connectionId,
    restored.missing > 0
      ? `${restored.missing} table${restored.missing === 1 ? "" : "s"} in this layout no longer exist in the database. They are marked on the canvas; remove them or keep them in case they come back.`
      : null,
  );
  autosaver.markClean(connectionId);
  persistence.setSaveState(connectionId, { status: "saved" });
  return { ok: true };
}

/**
 * When a connection is first shown, open its most recent saved workspace (if
 * any). Done once per live connection.
 */
export async function ensureWorkspaceLoaded(connectionId: string): Promise<void> {
  const persistence = usePersistenceStore.getState();
  if (persistence.loaded[connectionId]) return;
  persistence.setLoaded(connectionId); // set first: a second call while this runs must not start another

  const profileId = profileIdOf(connectionId);
  if (!profileId) return;

  const listed = await listWorkspaces(profileId);
  if (!listed.ok) {
    usePersistenceStore
      .getState()
      .setSaveState(connectionId, { status: "error", message: listed.error.message });
    return;
  }
  usePersistenceStore.getState().setSummaries(profileId, listed.data);

  const latest = listed.data[0];
  const hasTables = (useCanvasStore.getState().canvases[connectionId]?.nodes.length ?? 0) > 0;
  // If the user already put tables on the canvas while we were loading, do not replace their work.
  if (!latest || hasTables) return;

  const opened = await openWorkspace(connectionId, latest.id);
  if (!opened.ok)
    usePersistenceStore
      .getState()
      .setSaveState(connectionId, { status: "error", message: opened.message });
}

/** Start a fresh, empty layout. It is saved as a new workspace on the first change. */
export async function newWorkspace(connectionId: string): Promise<ActionResult> {
  await autosaver.flush(connectionId); // keep the layout we are leaving
  const persistence = usePersistenceStore.getState();
  const profileId = profileIdOf(connectionId);
  const count = (profileId ? persistence.summaries[profileId]?.length : 0) ?? 0;

  useCanvasStore.getState().clearCanvas(connectionId);
  persistence.setActive(connectionId, { id: null, name: `Layout ${count + 1}` });
  persistence.setNotice(connectionId, null);
  autosaver.markClean(connectionId);
  persistence.setSaveState(connectionId, { status: "idle" });
  return { ok: true };
}

export async function renameActiveWorkspace(
  connectionId: string,
  name: string,
): Promise<ActionResult> {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 100)
    return { ok: false, message: "Give the workspace a name of 1 to 100 characters." };
  const persistence = usePersistenceStore.getState();
  const active = persistence.active[connectionId];
  persistence.setActive(connectionId, { id: active?.id ?? null, name: trimmed });
  await autosaver.flush(connectionId); // a rename is part of the saved document, so this writes it
  const state = usePersistenceStore.getState().saveState[connectionId];
  return state?.status === "error" ? { ok: false, message: state.message } : { ok: true };
}

/** Delete the open workspace and leave an empty canvas. */
export async function deleteActiveWorkspace(connectionId: string): Promise<ActionResult> {
  const persistence = usePersistenceStore.getState();
  const active = persistence.active[connectionId];
  const profileId = profileIdOf(connectionId);

  if (active?.id) {
    const result = await deleteWorkspace(active.id);
    // "workspace_not_found": already gone, which is what we wanted.
    if (!result.ok && result.error.code !== "workspace_not_found")
      return { ok: false, message: result.error.message };
    if (profileId) persistence.removeSummary(profileId, active.id);
  }
  useCanvasStore.getState().clearCanvas(connectionId);
  persistence.setActive(connectionId, null);
  persistence.setNotice(connectionId, null);
  autosaver.markClean(connectionId);
  persistence.setSaveState(connectionId, { status: "idle" });
  return { ok: true };
}

/** Save pending changes, then ask the browser to download the workspace file. */
export async function exportActiveWorkspace(connectionId: string): Promise<ActionResult> {
  await autosaver.flush(connectionId);
  const id = usePersistenceStore.getState().active[connectionId]?.id;
  if (!id)
    return {
      ok: false,
      message: "There is nothing to export yet. Add a table to the canvas first.",
    };

  // A normal link with the `download` attribute: the browser saves the file the server sends.
  const link = document.createElement("a");
  link.href = exportUrl(id);
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
  return { ok: true };
}

/** The largest file we read into memory: a layout of thousands of tables is still far smaller. */
const MAX_IMPORT_BYTES = 1024 * 1024;

export async function importWorkspaceFile(connectionId: string, file: File): Promise<ActionResult> {
  const profileId = profileIdOf(connectionId);
  if (!profileId)
    return {
      ok: false,
      message: "Save this connection first, so the imported layout can be attached to it.",
    };
  if (file.size > MAX_IMPORT_BYTES)
    return { ok: false, message: "This file is too large to be a DataCanvas workspace." };

  let content: unknown;
  try {
    content = JSON.parse(await file.text());
  } catch {
    return {
      ok: false,
      message: "This file is not valid JSON, so it is not a DataCanvas workspace.",
    };
  }

  const imported = await importWorkspace(content, profileId);
  if (!imported.ok) return { ok: false, message: imported.error.message };

  usePersistenceStore.getState().upsertSummary(profileId, {
    id: imported.data.id,
    name: imported.data.name,
    updatedAt: imported.data.updatedAt,
    profileId,
    tableCount: imported.data.canvas.nodes.length,
  });
  return openWorkspace(connectionId, imported.data.id);
}

/** Save the live connection's non-secret details so its layouts can be kept across restarts. */
export async function saveCurrentConnection(connectionId: string): Promise<ActionResult> {
  const saved = await saveConnection(connectionId);
  if (!saved.ok) return { ok: false, message: saved.error.message };
  useWorkspaceStore.getState().updateConnection(saved.data);
  await useWorkspaceStore.getState().refreshProfiles();
  await autosaver.flush(connectionId); // save the layout that is already on the canvas
  return { ok: true };
}
