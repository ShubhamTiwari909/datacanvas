/**
 * The writes switch under a connection in the sidebar (decision 125), and the
 * read-mode role note (decision 126).
 *
 * Shown only when DataCanvas was started with `--enable-writes`. Then, for a
 * connection that is not on this machine, it is disabled with the reason; with
 * table data off, it says writing needs it; otherwise "Allow changes" opens the
 * unlock dialog. Once unlocked: a red "Writes on" badge, "Lock writes" and the
 * session's "Changes".
 */
"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, History, Lock, X } from "lucide-react";
import type { ConnectionSummary } from "@datacanvas/shared-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "cn";
import { useConnectionWrites, useWritesStore } from "@/stores/writes-store";
import { HistoryDialog } from "./history-dialog";
import { UnlockDialog } from "./unlock-dialog";

/** Appendix A of the editing plan. */
export const NOT_LOCAL_TEXT =
  "Writes are only available on a database running on this machine. This connection stays read-only.";

export function WritesControl({ connection }: { connection: ConnectionSummary }) {
  const writes = useConnectionWrites(connection.id);
  const refreshStatus = useWritesStore((s) => s.refreshStatus);
  const loadRole = useWritesStore((s) => s.loadRole);
  const lock = useWritesStore((s) => s.lock);
  const dismissRoleNote = useWritesStore((s) => s.dismissRoleNote);
  const [unlocking, setUnlocking] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);

  // Ask again whenever the connection's data access changes: writing needs it.
  useEffect(() => {
    void refreshStatus(connection.id);
  }, [connection.id, connection.dataAccess, refreshStatus]);

  useEffect(() => {
    void loadRole(connection.id);
  }, [connection.id, loadRole]);

  const { status, role } = writes;
  const readWarnings = role?.warnings.read ?? [];
  const noteText = readWarnings.map((w) => w.message).join(" ");
  const noteId = `role-note-${connection.id}`;
  const roleNote =
    !status.unlocked && !writes.roleNoteDismissed && readWarnings.length > 0 ? (
      <div
        role="note"
        className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs"
      >
        <AlertTriangle
          className="mt-0.5 size-3 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <span id={noteId} className={cn("min-w-0 flex-1", !noteOpen && "truncate")}>
          {noteText}
        </span>
        <Tip label={noteOpen ? "Show less" : "Show all"}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="-my-0.5"
            aria-expanded={noteOpen}
            aria-controls={noteId}
            onClick={() => setNoteOpen((open) => !open)}
            aria-label={`The whole role note for ${connection.name}`}
          >
            <ChevronDown className={cn(noteOpen && "rotate-180")} aria-hidden="true" />
          </Button>
        </Tip>
        <Tip label="Dismiss">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="-my-0.5"
            onClick={() => dismissRoleNote(connection.id)}
            aria-label={`Dismiss the role note for ${connection.name}`}
          >
            <X aria-hidden="true" />
          </Button>
        </Tip>
      </div>
    ) : null;

  if (!status.enabled) {
    return roleNote ? <div className="px-2 pb-1">{roleNote}</div> : null;
  }

  const switchId = `writes-${connection.id}`;
  const reason = !status.local
    ? NOT_LOCAL_TEXT
    : !status.dataAccess
      ? "Writing needs “Table data” switched on for this connection."
      : null;

  return (
    <div className="flex flex-col gap-1 px-2 pb-1">
      {status.unlocked ? (
        <div className="flex items-center gap-1">
          <Badge variant="destructive">Writes on</Badge>
          <span className="flex-1" />
          <Tip label="Lock writes">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setError(null);
                void lock(connection.id).then((r) => setError(r.ok ? null : r.error.message));
              }}
              aria-label={`Lock writes for ${connection.name}`}
            >
              <Lock aria-hidden="true" />
            </Button>
          </Tip>
          <Tip label="Changes made in this session">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setShowHistory(true)}
              aria-label={`Changes made to ${connection.name} in this session`}
            >
              <History aria-hidden="true" />
            </Button>
          </Tip>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Switch
            id={switchId}
            checked={false}
            disabled={reason !== null}
            onCheckedChange={(checked) => checked && setUnlocking(true)}
            aria-label={`Allow changes to ${connection.name}`}
            aria-describedby={reason ? `${switchId}-why` : undefined}
          />
          <label
            htmlFor={switchId}
            className="cursor-pointer text-xs text-muted-foreground aria-disabled:cursor-default"
          >
            Allow changes
          </label>
        </div>
      )}
      {reason ? (
        <p id={`${switchId}-why`} className="text-xs text-muted-foreground">
          {reason}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {roleNote}
      <UnlockDialog connection={connection} open={unlocking} onClose={() => setUnlocking(false)} />
      <HistoryDialog
        connectionId={connection.id}
        connectionName={connection.name}
        open={showHistory}
        onClose={() => setShowHistory(false)}
      />
    </div>
  );
}
