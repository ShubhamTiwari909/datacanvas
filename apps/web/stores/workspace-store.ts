/**
 * Client-side application state (Zustand).
 *
 * What lives here: the list of connections (a copy of what the server holds),
 * which connection and table the user is looking at, and whether the
 * "connect" dialog is open. It is shared by the sidebar, the main panel and
 * the dialog, which would otherwise have to pass props through many layers.
 *
 * The SERVER is the source of truth for connections (credentials live there);
 * this store only mirrors the password-free summaries.
 */
import type { ConnectionProfile, ConnectionSummary } from "@datacanvas/shared-types";
import { create } from "zustand";
import {
  deleteConnection,
  deleteProfile,
  listConnections,
  listProfiles,
} from "@/features/connections/api";
import { setDataAccess as requestDataAccess } from "@/features/data/api";
import { useCanvasStore } from "./canvas-store";
import { useMetadataStore } from "./metadata-store";
import { usePersistenceStore } from "./persistence-store";

/** What the main area shows for the selected connection. */
export type WorkspaceView =
  "canvas" | "details" | "overview" | "health" | "paths" | "snapshots" | "objects";

export interface SelectedTable {
  schema: string;
  name: string;
}

interface WorkspaceState {
  connections: ConnectionSummary[];
  /** Saved connections (no passwords). Those without a live connection are offered for reconnecting. */
  profiles: ConnectionProfile[];
  /** Loading state of the initial connection list. */
  status: "loading" | "ready" | "error";
  loadError: string | null;
  /** A message about the last failed action (for example a failed disconnect). */
  actionError: string | null;

  selectedConnectionId: string | null;
  selectedTable: SelectedTable | null;
  view: WorkspaceView;
  connectDialogOpen: boolean;
  /** When set, the dialog reconnects this saved connection (only the password is asked). */
  connectPrefill: ConnectionProfile | null;

  loadConnections: () => Promise<void>;
  addConnection: (connection: ConnectionSummary) => void;
  removeConnection: (id: string) => Promise<void>;
  selectConnection: (id: string) => void;
  selectTable: (table: SelectedTable | null) => void;
  setView: (view: WorkspaceView) => void;
  openConnectDialog: (prefill?: ConnectionProfile) => void;
  updateConnection: (connection: ConnectionSummary) => void;
  refreshProfiles: () => Promise<void>;
  /** Switch viewing table data on or off for a connection. Returns whether it worked (a failure shows as `actionError`). */
  setDataAccess: (id: string, enabled: boolean) => Promise<boolean>;
  removeProfile: (id: string) => Promise<void>;
  closeConnectDialog: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  connections: [],
  profiles: [],
  status: "loading",
  loadError: null,
  actionError: null,
  selectedConnectionId: null,
  selectedTable: null,
  view: "canvas",
  connectDialogOpen: false,
  connectPrefill: null,

  async loadConnections() {
    set({ status: "loading", loadError: null });
    // Live connections (kept in server memory) and saved ones (kept on disk) are separate lists.
    const [result, profiles] = await Promise.all([listConnections(), listProfiles()]);
    if (!result.ok) {
      set({ status: "error", loadError: result.error.message });
      return;
    }
    // The server keeps connections while it runs, so after a page reload they are still there.
    const selected = get().selectedConnectionId;
    const stillExists = result.data.some((c) => c.id === selected);
    set({
      status: "ready",
      // If the saved list could not be read, show none rather than blocking the app.
      profiles: profiles.ok ? profiles.data : [],
      connections: result.data,
      selectedConnectionId: stillExists ? selected : (result.data[0]?.id ?? null),
      selectedTable: stillExists ? get().selectedTable : null,
    });
  },

  addConnection(connection) {
    const known = get().profiles.some((p) => p.id === connection.profileId);
    set((state) => ({
      connections: [...state.connections, connection],
      selectedConnectionId: connection.id,
      selectedTable: null,
      connectDialogOpen: false,
      connectPrefill: null,
      actionError: null,
    }));
    // A connection saved just now has a profile this list has not seen: fetch it, so that
    // "Saved connections" is right as soon as the connection is closed (not only after a reload).
    if (connection.profileId !== null && !known) void get().refreshProfiles();
  },

  async removeConnection(id) {
    const result = await deleteConnection(id);
    // "connection_not_found" means it is already gone on the server: treat as success.
    if (!result.ok && result.error.code !== "connection_not_found") {
      set({ actionError: result.error.message });
      return;
    }
    // Forget everything derived from this connection: its canvas and cached structure.
    useCanvasStore.getState().dropConnection(id);
    useMetadataStore.getState().forgetConnection(id);
    usePersistenceStore.getState().forgetConnection(id);
    set((state) => {
      const connections = state.connections.filter((c) => c.id !== id);
      const wasSelected = state.selectedConnectionId === id;
      return {
        connections,
        actionError: null,
        selectedConnectionId: wasSelected
          ? (connections[0]?.id ?? null)
          : state.selectedConnectionId,
        selectedTable: wasSelected ? null : state.selectedTable,
      };
    });
  },

  selectConnection(id) {
    if (get().selectedConnectionId === id) return;
    set({ selectedConnectionId: id, selectedTable: null });
  },

  selectTable(table) {
    set({ selectedTable: table });
  },

  setView(view) {
    set({ view });
  },

  openConnectDialog(prefill) {
    set({ connectDialogOpen: true, connectPrefill: prefill ?? null });
  },

  updateConnection(connection) {
    set((state) => ({
      connections: state.connections.map((c) => (c.id === connection.id ? connection : c)),
    }));
  },

  async setDataAccess(id, enabled) {
    const result = await requestDataAccess(id, enabled);
    if (!result.ok) {
      set({ actionError: result.error.message });
      return false;
    }
    // The server remembered it with the saved connection; mirror both copies.
    get().updateConnection(result.data);
    set({ actionError: null });
    await get().refreshProfiles();
    return true;
  },

  async refreshProfiles() {
    const result = await listProfiles();
    if (result.ok) set({ profiles: result.data });
  },

  async removeProfile(id) {
    const result = await deleteProfile(id);
    if (!result.ok && result.error.code !== "profile_not_found") {
      set({ actionError: result.error.message });
      return;
    }
    set((state) => ({
      profiles: state.profiles.filter((p) => p.id !== id),
      actionError: null,
      // The server unlinked any live connection opened from it; mirror that here.
      connections: state.connections.map((c) =>
        c.profileId === id ? { ...c, profileId: null } : c,
      ),
    }));
  },

  closeConnectDialog() {
    set({ connectDialogOpen: false, connectPrefill: null });
  },
}));
