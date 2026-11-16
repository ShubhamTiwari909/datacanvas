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
 *
 * Answers can arrive out of order, and after a connection was closed. Each
 * connection therefore has an "epoch" (it changes when the connection is
 * forgotten, so a late answer cannot bring its state back) and a sequence number
 * for its status and for its history (only the newest request's answer is kept,
 * so a slow "status" read started before an unlock cannot undo the unlock).
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
  /** Changes when a connection is forgotten: an answer that started before is for a connection that is gone. */
  const epochs = new Map<string, number>();
  const epochOf = (connectionId: string) => epochs.get(connectionId) ?? 0;
  /** The newest status request and the newest history change per connection. */
  const statusSeq = new Map<string, number>();
  const historySeq = new Map<string, number>();
  const bump = (counters: Map<string, number>, connectionId: string): number => {
    const value = (counters.get(connectionId) ?? 0) + 1;
    counters.set(connectionId, value);
    return value;
  };

  const update = (connectionId: string, change: (current: ConnectionWrites) => ConnectionWrites) =>
    set((state) => ({
      byConnection: {
        ...state.byConnection,
        [connectionId]: change(state.byConnection[connectionId] ?? empty()),
      },
    }));

  /**
   * An unlock or lock was confirmed by the server. Show it unless the connection is gone; if a newer
   * status request has started since, ask again instead, so the screen settles on what the server
   * says now rather than on whichever answer happened to arrive last.
   */
  const settle = (connectionId: string, epoch: number, seq: number, status: WritesStatus) => {
    if (epochOf(connectionId) !== epoch) return;
    if (statusSeq.get(connectionId) === seq) update(connectionId, (c) => ({ ...c, status }));
    else void get().refreshStatus(connectionId);
  };

  return {
    byConnection: {},

    async refreshStatus(connectionId) {
      const epoch = epochOf(connectionId);
      const seq = bump(statusSeq, connectionId);
      const result = await getWritesStatus(connectionId);
      // Forgotten meanwhile, or a newer unlock, lock or read has started: this answer is out of date.
      if (epochOf(connectionId) !== epoch || statusSeq.get(connectionId) !== seq) return;
      // A server that cannot answer (an older one, or the connection is gone) means: no writes.
      update(connectionId, (c) => ({ ...c, status: result.ok ? result.data : WRITES_OFF }));
    },

    async loadRole(connectionId) {
      const epoch = epochOf(connectionId);
      const result = await getRole(connectionId);
      if (epochOf(connectionId) !== epoch) return;
      if (result.ok) update(connectionId, (c) => ({ ...c, role: result.data }));
    },

    async loadHistory(connectionId) {
      const epoch = epochOf(connectionId);
      const seq = historySeq.get(connectionId) ?? 0;
      const result = await getWritesHistory(connectionId);
      // A change was recorded since this read started: it would not be in this answer.
      if (epochOf(connectionId) !== epoch || (historySeq.get(connectionId) ?? 0) !== seq) return;
      // The server answers newest first; the store keeps the oldest first (as `recordChange`
      // appends) and the dialog turns it round once for display.
      if (result.ok) update(connectionId, (c) => ({ ...c, history: [...result.data].reverse() }));
    },

    async unlock(connectionId, database) {
      const epoch = epochOf(connectionId);
      const seq = bump(statusSeq, connectionId);
      const result = await unlockWrites(connectionId, database);
      if (!result.ok) return { ok: false, error: result.error };
      settle(connectionId, epoch, seq, result.data);
      return { ok: true };
    },

    async lock(connectionId) {
      const epoch = epochOf(connectionId);
      const seq = bump(statusSeq, connectionId);
      const result = await lockWrites(connectionId);
      if (!result.ok) {
        // Whatever happened, do not show writes as on when the server could not confirm it.
        await get().refreshStatus(connectionId);
        return { ok: false, error: result.error };
      }
      settle(connectionId, epoch, seq, result.data);
      return { ok: true };
    },

    recordChange(connectionId, entry) {
      bump(historySeq, connectionId);
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
      // A late answer for this connection must not bring its state back.
      epochs.set(connectionId, epochOf(connectionId) + 1);
      statusSeq.delete(connectionId);
      historySeq.delete(connectionId);
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
