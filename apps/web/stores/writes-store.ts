/**
 * Per-connection state of the write feature (1.4.0), in memory only.
 *
 * What lives here: whether writes are possible and unlocked (a copy of what
 * the server says), what the database role can do, the session history
 * (operations and column names, never values), whether the read-mode role
 * note was dismissed, and a counter that goes up after every change of
 * structure so the schema tree, its search, the table details and the canvas
 * know to read the structure again.
 *
 * Nothing is persisted: the unlock and the history belong to this session
 * (decisions 125 and 131), and a page reload asks the server again.
 */
import type { HistoryEntry, RoleResponse, WritesStatus } from "@datacanvas/shared-types";
import { create } from "zustand";
import {
  getRole,
  getWritesHistory,
  getWritesStatus,
  lockWrites,
  unlockWrites,
} from "@/features/writes/api";
import type { ApiFailure } from "@/lib/api-client";

/** What the browser assumes before the server answered, or when it cannot say: no writes. */
export const WRITES_OFF: WritesStatus = {
  enabled: false,
  local: false,
  dataAccess: false,
  unlocked: false,
};

export interface ConnectionWrites {
  status: WritesStatus;
  /** null until loaded; it stays null if the role could not be read. */
  role: RoleResponse | null;
  history: HistoryEntry[];
  /** The read-mode role note was dismissed for this session. */
  roleNoteDismissed: boolean;
  /** Goes up after each change of structure. */
  structureVersion: number;
}

const empty = (): ConnectionWrites => ({
  status: WRITES_OFF,
  role: null,
  history: [],
  roleNoteDismissed: false,
  structureVersion: 0,
});

type Outcome = { ok: true } | { ok: false; error: ApiFailure };

interface WritesState {
  byConnection: Record<string, ConnectionWrites | undefined>;
  /** Ask the server whether writes are possible (after connecting, a data-access change, unlock or lock). */
  refreshStatus: (connectionId: string) => Promise<void>;
  loadRole: (connectionId: string) => Promise<void>;
  loadHistory: (connectionId: string) => Promise<void>;
  unlock: (connectionId: string, database: string) => Promise<Outcome>;
  lock: (connectionId: string) => Promise<Outcome>;
  /** Add the entry the server returned after applying a change. */
  recordChange: (connectionId: string, entry: HistoryEntry) => void;
  dismissRoleNote: (connectionId: string) => void;
  bumpStructure: (connectionId: string) => void;
  forgetConnection: (connectionId: string) => void;
}

export const useWritesStore = create<WritesState>((set, get) => {
  const update = (connectionId: string, change: (current: ConnectionWrites) => ConnectionWrites) =>
    set((state) => ({
      byConnection: {
        ...state.byConnection,
        [connectionId]: change(state.byConnection[connectionId] ?? empty()),
      },
    }));

  return {
    byConnection: {},

    async refreshStatus(connectionId) {
      const result = await getWritesStatus(connectionId);
      // A server that cannot answer (an older one, or the connection is gone) means: no writes.
      update(connectionId, (c) => ({ ...c, status: result.ok ? result.data : WRITES_OFF }));
    },

    async loadRole(connectionId) {
      const result = await getRole(connectionId);
      if (result.ok) update(connectionId, (c) => ({ ...c, role: result.data }));
    },

    async loadHistory(connectionId) {
      const result = await getWritesHistory(connectionId);
      if (result.ok) update(connectionId, (c) => ({ ...c, history: result.data }));
    },

    async unlock(connectionId, database) {
      const result = await unlockWrites(connectionId, database);
      if (!result.ok) return { ok: false, error: result.error };
      update(connectionId, (c) => ({ ...c, status: result.data }));
      return { ok: true };
    },

    async lock(connectionId) {
      const result = await lockWrites(connectionId);
      if (!result.ok) {
        // Whatever happened, do not show writes as on when the server could not confirm it.
        await get().refreshStatus(connectionId);
        return { ok: false, error: result.error };
      }
      update(connectionId, (c) => ({ ...c, status: result.data }));
      return { ok: true };
    },

    recordChange(connectionId, entry) {
      update(connectionId, (c) => ({
        ...c,
        history: [...c.history.filter((e) => e.id !== entry.id), entry],
      }));
    },

    dismissRoleNote(connectionId) {
      update(connectionId, (c) => ({ ...c, roleNoteDismissed: true }));
    },

    bumpStructure(connectionId) {
      update(connectionId, (c) => ({ ...c, structureVersion: c.structureVersion + 1 }));
    },

    forgetConnection(connectionId) {
      set((state) => {
        const rest = { ...state.byConnection };
        delete rest[connectionId];
        return { byConnection: rest };
      });
    },
  };
});

/** The writes state of one connection (a stable empty one before anything was loaded). */
const EMPTY = empty();
export function useConnectionWrites(connectionId: string): ConnectionWrites {
  return useWritesStore((s) => s.byConnection[connectionId] ?? EMPTY);
}

/** The structure counter of a connection, for keys that must change after a change of structure. */
export function useStructureVersion(connectionId: string): number {
  return useWritesStore((s) => s.byConnection[connectionId]?.structureVersion ?? 0);
}

/** Can a change be sent for this connection right now? */
export function writesReady(status: WritesStatus): boolean {
  return status.enabled && status.local && status.dataAccess && status.unlocked;
}
