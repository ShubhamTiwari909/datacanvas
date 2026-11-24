/**
 * "Share with Claude" (decision 169): what Claude may read through this connection, what leaves the machine, and the text
 * that connects a Claude app. It says what happens BEFORE anything is shared. Only the structure level exists in this
 * step; the data level is shown as not available yet rather than hidden, so nobody looks for it.
 */
"use client";

import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { ConnectionSummary } from "@datacanvas/shared-types";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useClaudeLevel, useClaudeStore } from "@/stores/claude-store";
import {
  CLAUDE_CODE_COMMAND,
  CLAUDE_DESKTOP_CONFIG,
  HIDDEN_COLUMNS_NOTE,
  LEAVES_THE_MACHINE,
} from "./setup-text";

export function ShareWithClaudeDialog({
  connection,
  open,
  onClose,
}: {
  connection: ConnectionSummary;
  open: boolean;
  onClose: () => void;
}) {
  const level = useClaudeLevel(connection.id);
  const share = useClaudeStore((s) => s.set);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shared = level !== "off";

  async function change(next: "structure" | "off") {
    setBusy(true);
    setError(null);
    const failure = await share(connection.id, next);
    setBusy(false);
    if (failure) setError(failure.message);
    else if (next === "off") onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>Share {connection.name} with Claude</DialogTitle>
          <DialogDescription>
            Lets a Claude app (Claude Desktop, Claude Code) read this database through DataCanvas.
            It can only read: no tool changes anything.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">What Claude can read</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`claude-level-${connection.id}`}
              checked
              readOnly
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span className="font-medium">Structure</span>
              <span className="text-xs text-muted-foreground">
                Schema, table and column names, types, keys, indexes and the server&apos;s
                statistics. No row of any table.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm opacity-70">
            <input
              type="radio"
              name={`claude-level-${connection.id}`}
              disabled
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span className="font-medium">Structure and data</span>
              <span className="text-xs text-muted-foreground">
                Read-only queries and rows. Not available yet: it comes with its own approval step.
              </span>
            </span>
          </label>
        </fieldset>

        <div
          role="note"
          className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-50"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            <strong>{LEAVES_THE_MACHINE}</strong> {HIDDEN_COLUMNS_NOTE} Sharing lasts until you stop
            it, disconnect, or close DataCanvas: it is never saved.
          </p>
        </div>

        <section className="flex flex-col gap-2" aria-labelledby={`claude-setup-${connection.id}`}>
          <h3 id={`claude-setup-${connection.id}`} className="text-sm font-medium">
            Connect a Claude app (once)
          </h3>
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Claude Code: run this</span>
              <CopyButton text={CLAUDE_CODE_COMMAND} label="Copy the command for Claude Code" />
            </div>
            <pre
              tabIndex={0}
              aria-label="Command for Claude Code"
              className="overflow-auto rounded-md bg-muted p-2 font-mono text-xs"
            >
              {CLAUDE_CODE_COMMAND}
            </pre>
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Claude Desktop: add this to claude_desktop_config.json, then restart it
              </span>
              <CopyButton text={CLAUDE_DESKTOP_CONFIG} label="Copy the config for Claude Desktop" />
            </div>
            <pre
              tabIndex={0}
              aria-label="Config for Claude Desktop"
              className="overflow-auto rounded-md bg-muted p-2 font-mono text-xs"
            >
              {CLAUDE_DESKTOP_CONFIG}
            </pre>
          </div>
          <p className="text-xs text-muted-foreground">
            The same text works on every run: nothing in it changes, and no secret is in it.
          </p>
        </section>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {shared ? "Close" : "Cancel"}
          </Button>
          {shared ? (
            <Button variant="destructive" disabled={busy} onClick={() => void change("off")}>
              Stop sharing
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void change("structure")}>
              Start sharing the structure
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
