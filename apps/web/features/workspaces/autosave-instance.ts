/**
 * The autosaver the app uses, wired to the real API and the workspace store.
 * (Kept apart from autosave.ts so tests can build their own with fakes.)
 */
import { useWorkspaceStore } from "@/stores/workspace-store";
import { saveWorkspace } from "./api";
import { createAutosaver } from "./autosave";

export const autosaver = createAutosaver({
  getProfileId: (connectionId) =>
    useWorkspaceStore.getState().connections.find((c) => c.id === connectionId)?.profileId,
  getHint: (connectionId) => {
    const connection = useWorkspaceStore.getState().connections.find((c) => c.id === connectionId);
    return connection ? { connectionName: connection.name, database: connection.database } : null;
  },
  save: saveWorkspace,
  // 32 hex characters: matches the id pattern, and unguessable.
  newId: () => crypto.randomUUID().replaceAll("-", ""),
});
