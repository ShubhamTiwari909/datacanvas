/**
 * Unlocking writes for one connection, for this session (decision 125): the
 * person types the database's name. The dialog shows the address the SERVER
 * reports (a tunnel on 127.0.0.1 can lead to a remote database, so the host
 * alone proves little) and the role warnings for write mode.
 */
"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { ConnectionSummary } from "@datacanvas/shared-types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConnectionWrites, useWritesStore } from "@/stores/writes-store";
import { ADDRESS_UNKNOWN_WARNING, serverAddressText } from "./unlock";

export function UnlockDialog({
  connection,
  open,
  onClose,
}: {
  connection: ConnectionSummary;
  open: boolean;
  onClose: () => void;
}) {
  const { role, roleFailed } = useConnectionWrites(connection.id);
  const unlock = useWritesStore((s) => s.unlock);
  const loadRole = useWritesStore((s) => s.loadRole);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the SERVER reports is the main check against a tunnel or proxy to a remote database, so
  // "not read yet", "could not be read" and "no address (a local socket)" are three different things.
  const address = serverAddressText(role, roleFailed);
  const warnings = role?.warnings.write ?? [];
  const inputId = `unlock-${connection.id}`;

  // Ask again whenever the dialog opens without an answer (the first attempt may have failed).
  useEffect(() => {
    if (open && role === null) void loadRole(connection.id);
  }, [open, role, connection.id, loadRole]);

  function close() {
    setTyped("");
    setError(null);
    onClose();
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await unlock(connection.id, typed);
    setBusy(false);
    if (result.ok) close();
    else setError(result.error.message);
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && close()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed !== "" && !busy) void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Allow changes to {connection.database}?</DialogTitle>
            <DialogDescription>
              Allow changes to{" "}
              <strong className="font-medium text-foreground">{connection.database}</strong>
              {address.known ? (
                <>
                  {" "}
                  on <strong className="font-medium text-foreground">{address.text}</strong>
                </>
              ) : null}
              ? Changes are committed immediately and cannot be undone. Type the database name to
              confirm, and make sure this is not a production database.
            </DialogDescription>
          </DialogHeader>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Host you connected to</dt>
            <dd className="font-mono">{connection.host}</dd>
            <dt className="text-muted-foreground">Address the server reports</dt>
            <dd className="font-mono">{address.text}</dd>
            {role ? (
              <>
                <dt className="text-muted-foreground">Database role</dt>
                <dd className="font-mono">{role.role.roleName}</dd>
              </>
            ) : null}
          </dl>

          {!address.known ? (
            <p
              role="note"
              className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-sm"
            >
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              {ADDRESS_UNKNOWN_WARNING}
            </p>
          ) : null}

          {warnings.length > 0 ? (
            <ul aria-label="Role warnings" className="flex flex-col gap-2">
              {warnings.map((warning) => (
                <li
                  key={warning.code}
                  className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-sm"
                >
                  <AlertTriangle
                    className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                    aria-hidden="true"
                  />
                  {warning.message}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={inputId}>Database name</Label>
            <Input
              id={inputId}
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              aria-invalid={error !== null}
              aria-describedby={error ? `${inputId}-error` : undefined}
            />
            {error ? (
              <p id={`${inputId}-error`} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={typed === "" || busy}>
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Allow changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
