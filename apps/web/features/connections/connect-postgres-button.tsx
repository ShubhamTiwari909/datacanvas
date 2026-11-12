/**
 * "Connect PostgreSQL" call-to-action.
 *
 * This is a Client Component because it owns interactive state (is the dialog
 * open?). The dialog holds the connection-string form; Phase 6 extends it
 * with Test Connection, the fields-based form and saving.
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
import { ConnectionStringForm } from "./connection-string-form";

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
              Paste a connection string. Credentials stay on your machine. For now DataCanvas only
              checks the format; it does not connect yet.
            </DialogDescription>
          </DialogHeader>
          <ConnectionStringForm />
        </DialogContent>
      </Dialog>
    </>
  );
}
