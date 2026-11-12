/**
 * "Connect PostgreSQL" call-to-action. It only asks the store to open the
 * dialog, so it can be placed anywhere (welcome screen, sidebar).
 */
"use client";

import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspace-store";

export function ConnectPostgresButton() {
  const open = useWorkspaceStore((s) => s.openConnectDialog);
  return (
    <Button size="lg" onClick={open}>
      Connect PostgreSQL
    </Button>
  );
}
