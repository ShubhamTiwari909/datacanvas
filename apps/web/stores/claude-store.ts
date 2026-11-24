/**
 * What is shared with Claude, per connection (decision 169): a copy of what the server says, in memory only. The server is
 * the truth: it forgets a sharing on a restart, a disconnect, and (for the data level) when viewing table data is switched
 * off, so the level is read again whenever the connection or its data access changes.
 */
import type { ClaudeLevel } from "@datacanvas/shared-types";
import { create } from "zustand";
import { getClaudeSharing, setClaudeSharing } from "@/features/claude/api";
import type { ApiFailure } from "@/lib/api-client";

interface ClaudeState {
  levels: Record<string, ClaudeLevel>;
  /** Ask the server what is shared for this connection. */
  load: (connectionId: string) => Promise<void>;
  /** Share at a level, or stop (`off`). Returns the failure to show, or null. */
  set: (connectionId: string, level: ClaudeLevel) => Promise<ApiFailure | null>;
  /** Forget a connection (it was disconnected). */
  forget: (connectionId: string) => void;
}

export const useClaudeStore = create<ClaudeState>((set) => ({
  levels: {},
  load: async (connectionId) => {
    const result = await getClaudeSharing(connectionId);
    if (result.ok) set((s) => ({ levels: { ...s.levels, [connectionId]: result.data } }));
  },
  set: async (connectionId, level) => {
    const result = await setClaudeSharing(connectionId, level);
    if (!result.ok) return result.error;
    set((s) => ({ levels: { ...s.levels, [connectionId]: result.data } }));
    return null;
  },
  forget: (connectionId) =>
    set((s) => {
      const { [connectionId]: _gone, ...rest } = s.levels;
      return { levels: rest };
    }),
}));

export const useClaudeLevel = (connectionId: string): ClaudeLevel =>
  useClaudeStore((s) => s.levels[connectionId] ?? "off");
