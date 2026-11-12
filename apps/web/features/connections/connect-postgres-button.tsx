/**
 * "Connect PostgreSQL" call-to-action.
 *
 * This is a Client Component because it owns interactive state (is the dialog
 * open?). In Phase 1 the dialog is a placeholder; Phase 6 replaces its body
 * with the real connection form (paste a connection string, or fill fields).
 */
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ConnectPostgresButton() {
  // State: changing it re-renders this component and shows/hides the dialog.
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="lg" onClick={() => setOpen(true)}>
        Connect PostgreSQL
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect PostgreSQL</DialogTitle>
            <DialogDescription>
              The connection form is coming in a later phase. You will be able to paste a connection
              string or fill in host, port, database and credentials. Credentials stay on your
              machine.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}
