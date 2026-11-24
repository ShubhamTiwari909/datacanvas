/**
 * What is shared with Claude, per connection, and what Claude is doing (decision 169): a copy of what the server says, in
 * memory only. The server is the truth: it forgets a sharing on a restart, a disconnect, and (for the data level) when viewing
 * table data is switched off, so the state is read again, and `refresh` (polled while anything is shared) brings it back in line.
 */
import type { ClaudeActivity, ClaudeLevel } from "@datacanvas/shared-types";
import { create } from "zustand";
import {
  decideClaudeCall,
  getClaudeActivity,
  getClaudeSharing,
  setClaudePaused,
  setClaudeSharing,
  type ClaudeSharing,
} from "@/features/claude/api";
import type { ApiFailure } from "@/lib/api-client";

interface ClaudeState {
  sharing: Record<string, ClaudeSharing>;
  /** The last answer of the activity route, or null before the first one. */
  activity: ClaudeActivity | null;
  /** Ask the server what is shared for this connection. */
  load: (connectionId: string) => Promise<void>;
  /** Share at a level, or stop (`off`). Returns the failure to show, or null. */
  set: (
    connectionId: string,
    request: { level: ClaudeLevel; approval?: boolean; acknowledgeRole?: boolean },
  ) => Promise<ApiFailure | null>;
  /** Forget a connection (it was disconnected). */
  forget: (connectionId: string) => void;
  /** Read the activity list, the waiting approvals and the pause, and bring the sharing in line with the server. */
  refresh: () => Promise<void>;
  decide: (callId: string, decision: "approve" | "deny") => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
}

export const useClaudeStore = create<ClaudeState>((set, get) => ({
  sharing: {},
  activity: null,
  load: async (connectionId) => {
    const result = await getClaudeSharing(connectionId);
    if (result.ok) set((s) => ({ sharing: { ...s.sharing, [connectionId]: result.data } }));
  },
  set: async (connectionId, request) => {
    const result = await setClaudeSharing(connectionId, request);
    if (!result.ok) return result.error;
    set((s) => ({ sharing: { ...s.sharing, [connectionId]: result.data } }));
    if (result.data.level === "off") set({ activity: null });
    else void get().refresh();
    return null;
  },
  forget: (connectionId) =>
    set((s) => {
      const { [connectionId]: _gone, ...rest } = s.sharing;
      return { sharing: rest };
    }),
  refresh: async () => {
    const result = await getClaudeActivity();
    if (!result.ok) return;
    const sharing: Record<string, ClaudeSharing> = {};
    for (const c of result.data.shared) sharing[c.id] = { level: c.level, approval: c.approval };
    set({ activity: result.data, sharing });
  },
  decide: async (callId, decision) => {
    await decideClaudeCall(callId, decision);
    await get().refresh();
  },
  setPaused: async (paused) => {
    await setClaudePaused(paused);
    await get().refresh();
  },
}));

export const useClaudeLevel = (connectionId: string): ClaudeLevel =>
  useClaudeStore((s) => s.sharing[connectionId]?.level ?? "off");
