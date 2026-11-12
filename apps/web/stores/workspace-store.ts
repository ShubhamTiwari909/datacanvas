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
import type { ConnectionSummary } from "@datacanvas/shared-types";
import { create } from "zustand";
import { deleteConnection, listConnections } from "@/features/connections/api";

export interface SelectedTable {
  schema: string;
  name: string;
}

interface WorkspaceState {
  connections: ConnectionSummary[];
  /** Loading state of the initial connection list. */
  status: "loading" | "ready" | "error";
  loadError: string | null;
  /** A message about the last failed action (for example a failed disconnect). */
  actionError: string | null;

  selectedConnectionId: string | null;
  selectedTable: SelectedTable | null;
  connectDialogOpen: boolean;

  loadConnections: () => Promise<void>;
  addConnection: (connection: ConnectionSummary) => void;
  removeConnection: (id: string) => Promise<void>;
  selectConnection: (id: string) => void;
  selectTable: (table: SelectedTable | null) => void;
  openConnectDialog: () => void;
  closeConnectDialog: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  connections: [],
  status: "loading",
  loadError: null,
  actionError: null,
  selectedConnectionId: null,
  selectedTable: null,
  connectDialogOpen: false,

  async loadConnections() {
    set({ status: "loading", loadError: null });
    const result = await listConnections();
    if (!result.ok) {
      set({ status: "error", loadError: result.error.message });
      return;
    }
    // The server keeps connections while it runs, so after a page reload they are still there.
    const selected = get().selectedConnectionId;
    const stillExists = result.data.some((c) => c.id === selected);
    set({
      status: "ready",
      connections: result.data,
      selectedConnectionId: stillExists ? selected : (result.data[0]?.id ?? null),
      selectedTable: stillExists ? get().selectedTable : null,
    });
  },

  addConnection(connection) {
    set((state) => ({
      connections: [...state.connections, connection],
      selectedConnectionId: connection.id,
      selectedTable: null,
      connectDialogOpen: false,
      actionError: null,
    }));
  },

  async removeConnection(id) {
    const result = await deleteConnection(id);
    // "connection_not_found" means it is already gone on the server: treat as success.
    if (!result.ok && result.error.code !== "connection_not_found") {
      set({ actionError: result.error.message });
      return;
    }
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

  openConnectDialog() {
    set({ connectDialogOpen: true });
  },

  closeConnectDialog() {
    set({ connectDialogOpen: false });
  },
}));
