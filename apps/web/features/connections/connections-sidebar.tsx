/**
 * The sidebar: the list of connections (with disconnect buttons) and, under
 * the selected connection, its schema tree.
 */
"use client";

import { Plus, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SchemaTree } from "@/features/explorer/schema-tree";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace-store";

export function ConnectionsSidebar() {
  const connections = useWorkspaceStore((s) => s.connections);
  const selectedId = useWorkspaceStore((s) => s.selectedConnectionId);
  const actionError = useWorkspaceStore((s) => s.actionError);
  const selectConnection = useWorkspaceStore((s) => s.selectConnection);
  const removeConnection = useWorkspaceStore((s) => s.removeConnection);
  const openDialog = useWorkspaceStore((s) => s.openConnectDialog);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Connections
        </h2>
        <Button variant="ghost" size="icon-xs" onClick={openDialog} aria-label="Add a connection">
          <Plus aria-hidden="true" />
        </Button>
      </div>

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No connections yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {connections.map((connection) => {
            const selected = connection.id === selectedId;
            return (
              <li key={connection.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => selectConnection(connection.id)}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 text-left hover:bg-accent",
                    selected && "bg-accent",
                  )}
                >
                  <span className="truncate text-sm font-medium">{connection.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {connection.database} @ {connection.host}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void removeConnection(connection.id)}
                  aria-label={`Disconnect ${connection.name}`}
                  title="Disconnect and forget the credentials"
                >
                  <Unplug aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {selectedId ? (
        <div className="min-h-0 flex-1 overflow-y-auto border-t pt-3">
          {/* `key` resets the tree (and its open/closed state) when another connection is chosen. */}
          <SchemaTree key={selectedId} connectionId={selectedId} />
        </div>
      ) : null}
    </div>
  );
}
