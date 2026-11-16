/**
 * The sidebar: the list of connections (with disconnect buttons) and, under
 * the selected connection, its schema tree.
 */
"use client";

import { Plug, Plus, Trash2, Unplug } from "lucide-react";
import { useState } from "react";
import type { ConnectionProfile } from "@datacanvas/shared-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { SchemaTree } from "@/features/explorer/schema-tree";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace-store";

export function ConnectionsSidebar() {
  const connections = useWorkspaceStore((s) => s.connections);
  const selectedId = useWorkspaceStore((s) => s.selectedConnectionId);
  const actionError = useWorkspaceStore((s) => s.actionError);
  const selectConnection = useWorkspaceStore((s) => s.selectConnection);
  const removeConnection = useWorkspaceStore((s) => s.removeConnection);
  const setDataAccess = useWorkspaceStore((s) => s.setDataAccess);
  const openDialog = useWorkspaceStore((s) => s.openConnectDialog);
  const profiles = useWorkspaceStore((s) => s.profiles);
  const removeProfile = useWorkspaceStore((s) => s.removeProfile);
  const [forgetTarget, setForgetTarget] = useState<ConnectionProfile | null>(null);

  // Saved connections that are not currently open: these are offered for reconnecting.
  const openProfileIds = new Set(connections.map((c) => c.profileId));
  const saved = profiles.filter((p) => !openProfileIds.has(p.id));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Connections
        </h2>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => openDialog()}
          aria-label="Add a connection"
        >
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
              <li key={connection.id} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1">
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
                </div>
                <div className="flex items-center gap-2 px-2 pb-1">
                  <Switch
                    id={`data-access-${connection.id}`}
                    checked={connection.dataAccess}
                    onCheckedChange={(enabled) => void setDataAccess(connection.id, enabled)}
                    aria-label={`Allow viewing table data for ${connection.name}`}
                  />
                  <label
                    htmlFor={`data-access-${connection.id}`}
                    className="cursor-pointer text-xs text-muted-foreground"
                  >
                    Table data
                  </label>
                  {connection.dataAccess ? <Badge variant="outline">on</Badge> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {saved.length > 0 ? (
        <div className="flex flex-col gap-1 border-t pt-3">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Saved connections
          </h2>
          <ul className="flex flex-col gap-1">
            {saved.map((profile) => (
              <li key={profile.id} className="flex items-center gap-1">
                <div className="flex min-w-0 flex-1 flex-col px-2 py-1">
                  <span className="truncate text-sm font-medium">{profile.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {profile.database} @ {profile.host}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => openDialog(profile)}
                  aria-label={`Connect ${profile.name} (asks for the password)`}
                  title="Connect (asks for the password)"
                >
                  <Plug aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setForgetTarget(profile)}
                  aria-label={`Forget ${profile.name}`}
                  title="Forget this saved connection and its layouts"
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Dialog open={forgetTarget !== null} onOpenChange={(open) => !open && setForgetTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Forget “{forgetTarget?.name}”?</DialogTitle>
            <DialogDescription>
              This removes the saved connection details AND the layouts saved for it. Your database
              is not touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForgetTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (forgetTarget) void removeProfile(forgetTarget.id);
                setForgetTarget(null);
              }}
            >
              Forget
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selectedId ? (
        <div className="min-h-0 flex-1 overflow-y-auto border-t pt-3">
          {/* `key` resets the tree (and its open/closed state) when another connection is chosen. */}
          <SchemaTree key={selectedId} connectionId={selectedId} />
        </div>
      ) : null}
    </div>
  );
}
