/**
 * Client-side state about SAVING: which workspace is open for each connection,
 * the list of saved workspaces, and the autosave status. (The layout itself is
 * in the canvas store; the files live on the server.)
 */
import type { WorkspaceSummary } from "@datacanvas/shared-types";
import { create } from "zustand";

/** The workspace shown on a connection's canvas. `id` is null until the first save creates it. */
export interface ActiveWorkspace {
  id: string | null;
  name: string;
}

export type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; message: string };

interface PersistenceState {
  /** Saved workspaces, by saved-connection (profile) id. */
  summaries: Record<string, WorkspaceSummary[] | undefined>;
  /** The open workspace, by live-connection id. */
  active: Record<string, ActiveWorkspace | undefined>;
  /** Whether the saved layout for a live connection has been looked up yet (done once per connection). */
  loaded: Record<string, boolean | undefined>;
  saveState: Record<string, SaveState | undefined>;
  /** A message to show about the last open or import, by live-connection id. */
  notices: Record<string, string | null | undefined>;

  setSummaries: (profileId: string, summaries: WorkspaceSummary[]) => void;
  upsertSummary: (profileId: string, summary: WorkspaceSummary) => void;
  removeSummary: (profileId: string, workspaceId: string) => void;
  setActive: (connectionId: string, active: ActiveWorkspace | null) => void;
  setLoaded: (connectionId: string) => void;
  setSaveState: (connectionId: string, state: SaveState) => void;
  setNotice: (connectionId: string, notice: string | null) => void;
  forgetConnection: (connectionId: string) => void;
}

export const usePersistenceStore = create<PersistenceState>((set) => ({
  summaries: {},
  active: {},
  loaded: {},
  saveState: {},
  notices: {},

  setSummaries: (profileId, summaries) =>
    set((s) => ({ summaries: { ...s.summaries, [profileId]: summaries } })),

  upsertSummary: (profileId, summary) =>
    set((s) => {
      const others = (s.summaries[profileId] ?? []).filter((w) => w.id !== summary.id);
      // Newest first, like the server's list.
      const next = [summary, ...others].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { summaries: { ...s.summaries, [profileId]: next } };
    }),

  removeSummary: (profileId, workspaceId) =>
    set((s) => ({
      summaries: {
        ...s.summaries,
        [profileId]: (s.summaries[profileId] ?? []).filter((w) => w.id !== workspaceId),
      },
    })),

  setActive: (connectionId, active) =>
    set((s) => ({ active: { ...s.active, [connectionId]: active ?? undefined } })),
  setLoaded: (connectionId) => set((s) => ({ loaded: { ...s.loaded, [connectionId]: true } })),
  setSaveState: (connectionId, state) =>
    set((s) => ({ saveState: { ...s.saveState, [connectionId]: state } })),
  setNotice: (connectionId, notice) =>
    set((s) => ({ notices: { ...s.notices, [connectionId]: notice } })),

  forgetConnection: (connectionId) =>
    set((s) => {
      const drop = <T>(record: Record<string, T>): Record<string, T> => {
        const rest = { ...record };
        delete rest[connectionId];
        return rest;
      };
      return {
        active: drop(s.active),
        loaded: drop(s.loaded),
        saveState: drop(s.saveState),
        notices: drop(s.notices),
      };
    }),
}));
