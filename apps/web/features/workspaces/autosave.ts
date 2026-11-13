/**
 * Autosave: keeps the saved layout up to date while the user works.
 *
 * HOW IT WORKS
 *   - It listens to the canvas store. Dragging changes node positions dozens of
 *     times a second, so it does not save on every change: each change
 *     restarts a short timer ("debounce"), and the save happens when the user
 *     has paused for `delayMs`.
 *   - Before saving it builds the document that WOULD be saved and compares it
 *     with the last one saved. Changes that do not affect the file (selecting a
 *     table, a node being measured) therefore never cause a write.
 *   - One save per connection runs at a time. If the canvas changed while a
 *     save was in flight, another save follows.
 *   - Only connections linked to a saved profile are saved: the file needs
 *     something to be found by after a restart.
 *   - The first save of a new layout creates the workspace (a client-made id);
 *     later saves update it.
 */
import type { ConnectionHint, Workspace, WorkspaceInput } from "@datacanvas/shared-types";
import type { ApiResult } from "@/lib/api-client";
import { summarizeWorkspace } from "@datacanvas/shared-types";
import { useCanvasStore } from "@/stores/canvas-store";
import { usePersistenceStore } from "@/stores/persistence-store";
import { canvasSignature, serializeCanvas } from "./serialize";

/** How long the user must pause before a save happens. */
export const AUTOSAVE_DELAY_MS = 800;

export interface AutosaveDependencies {
  /** The saved-connection id of a live connection, or null/undefined if it is not saved. */
  getProfileId: (connectionId: string) => string | null | undefined;
  getHint: (connectionId: string) => ConnectionHint | null;
  save: (id: string, input: WorkspaceInput) => Promise<ApiResult<Workspace>>;
  newId: () => string;
  delayMs?: number;
}

export interface Autosaver {
  /** Start listening. Returns a function that stops it (and cancels pending saves). */
  start: () => () => void;
  /** Save now if there is anything unsaved, waiting for any save in progress. */
  flush: (connectionId: string) => Promise<void>;
  /** Treat the CURRENT canvas as already saved (after opening a workspace), so it is not written back needlessly. */
  markClean: (connectionId: string) => void;
}

export function createAutosaver(deps: AutosaveDependencies): Autosaver {
  const delayMs = deps.delayMs ?? AUTOSAVE_DELAY_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastSaved = new Map<string, string>(); // signature of the last saved document
  const inFlight = new Set<string>();
  const dirtyAgain = new Set<string>();

  /** The document that would be saved for a connection right now, or null if there is no canvas. */
  function currentDocument(connectionId: string) {
    const canvasState = useCanvasStore.getState().canvases[connectionId];
    if (!canvasState) return null;
    const active = usePersistenceStore.getState().active[connectionId];
    const canvas = serializeCanvas(canvasState.nodes, canvasState.viewport);
    const name = active?.name ?? "Layout";
    return { canvas, name, signature: canvasSignature(canvas, name), active };
  }

  async function save(connectionId: string): Promise<void> {
    const profileId = deps.getProfileId(connectionId);
    const document = currentDocument(connectionId);
    if (!profileId || !document) return;
    if (document.signature === lastSaved.get(connectionId)) return;
    // An empty canvas that was never saved has nothing worth a file.
    if (!document.active?.id && document.canvas.nodes.length === 0) return;

    if (inFlight.has(connectionId)) {
      dirtyAgain.add(connectionId);
      return;
    }
    inFlight.add(connectionId);
    const persistence = usePersistenceStore.getState();
    persistence.setSaveState(connectionId, { status: "saving" });

    const id = document.active?.id ?? deps.newId();
    const result = await deps.save(id, {
      name: document.name,
      profileId,
      connectionHint: deps.getHint(connectionId),
      canvas: document.canvas,
    });
    inFlight.delete(connectionId);

    const after = usePersistenceStore.getState();
    if (result.ok) {
      lastSaved.set(connectionId, document.signature);
      after.setActive(connectionId, { id, name: document.name });
      after.upsertSummary(profileId, summarizeWorkspace(result.data));
      after.setSaveState(connectionId, { status: "saved" });
    } else {
      after.setSaveState(connectionId, { status: "error", message: result.error.message });
    }
    // The canvas changed while we were saving: save again.
    if (dirtyAgain.delete(connectionId)) schedule(connectionId);
  }

  function schedule(connectionId: string): void {
    clearTimeout(timers.get(connectionId));
    timers.set(
      connectionId,
      setTimeout(() => {
        timers.delete(connectionId);
        void save(connectionId);
      }, delayMs),
    );
  }

  return {
    start() {
      const unsubscribe = useCanvasStore.subscribe((state, previous) => {
        for (const connectionId of Object.keys({ ...previous.canvases, ...state.canvases })) {
          const now = state.canvases[connectionId];
          if (now === previous.canvases[connectionId]) continue;
          if (now === undefined) {
            // The connection was disconnected: forget everything about it.
            clearTimeout(timers.get(connectionId));
            timers.delete(connectionId);
            lastSaved.delete(connectionId);
            continue;
          }
          schedule(connectionId);
        }
      });
      return () => {
        unsubscribe();
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
      };
    },

    async flush(connectionId) {
      clearTimeout(timers.get(connectionId));
      timers.delete(connectionId);
      // Wait for a save in progress, then save whatever is still unsaved.
      while (inFlight.has(connectionId)) await new Promise((resolve) => setTimeout(resolve, 10));
      await save(connectionId);
    },

    markClean(connectionId) {
      clearTimeout(timers.get(connectionId));
      timers.delete(connectionId);
      const document = currentDocument(connectionId);
      if (document) lastSaved.set(connectionId, document.signature);
    },
  };
}
