/**
 * The "Connect PostgreSQL" dialog. Mounted once; opened from anywhere through
 * the store's `openConnectDialog()`.
 */
"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { ConnectionForm } from "./connection-form";

export function ConnectDialog() {
  const open = useWorkspaceStore((s) => s.connectDialogOpen);
  const close = useWorkspaceStore((s) => s.closeConnectDialog);
  const addConnection = useWorkspaceStore((s) => s.addConnection);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect PostgreSQL</DialogTitle>
          <DialogDescription>
            Paste a connection string or fill in the details, then connect to explore the database.
          </DialogDescription>
        </DialogHeader>
        {/* Remounted on each open (the Dialog unmounts its content when closed), so it starts empty. */}
        <ConnectionForm onConnected={addConnection} />
      </DialogContent>
    </Dialog>
  );
}
