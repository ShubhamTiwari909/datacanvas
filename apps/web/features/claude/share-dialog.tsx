/**
 * "Share with Claude" (decision 169): what Claude may read through this connection, what leaves the machine, and the text
 * that connects a Claude app. It says what happens BEFORE anything is shared. The data level needs a tick that rows are sent
 * to Anthropic, asks for Approve before each call unless the person turns that off, and, for a superuser, a second "share
 * anyway". Below, once shared: what Claude asked, as the server lists it (never what came back).
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
import { useClaudeStore } from "@/stores/claude-store";
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
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      {/* The form exists only while the dialog is open, so it starts from what is shared at that moment. */}
      {open ? <ShareForm connection={connection} onClose={onClose} /> : null}
    </Dialog>
  );
}

function ShareForm({
  connection,
  onClose,
}: {
  connection: ConnectionSummary;
  onClose: () => void;
}) {
  const current = useClaudeStore((s) => s.sharing[connection.id]);
  const activity = useClaudeStore((s) => s.activity);
  const share = useClaudeStore((s) => s.set);
  const level = current?.level ?? "off";
  const shared = level !== "off";
  const [choice, setChoice] = useState<"structure" | "data">(
    level === "data" ? "data" : "structure",
  );
  const [approval, setApproval] = useState(current?.approval ?? true);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [riskyRole, setRiskyRole] = useState(false);

  const dataReady = connection.dataAccess;
  const wantsData = choice === "data";
  const canStart = !busy && (!wantsData || (dataReady && understood));

  async function change(next: "structure" | "data" | "off", acknowledgeRole = false) {
    setBusy(true);
    setError(null);
    const failure = await share(connection.id, {
      level: next,
      ...(next === "data" ? { approval, acknowledgeRole } : {}),
    });
    setBusy(false);
    if (failure) {
      if (failure.code === "claude_role_not_acknowledged") setRiskyRole(true);
      setError(failure.message);
    } else if (next === "off") onClose();
  }

  const mine = (activity?.activity ?? [])
    .filter((c) => c.connection === connection.id)
    .slice(0, 15);

  return (
    <DialogContent size="form">
      <DialogHeader>
        <DialogTitle>Share {connection.name} with Claude</DialogTitle>
        <DialogDescription>
          Lets a Claude app (Claude Desktop, Claude Code) read this database through DataCanvas. It
          can only read: no tool changes anything.
        </DialogDescription>
      </DialogHeader>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">What Claude can read</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`claude-level-${connection.id}`}
            checked={choice === "structure"}
            onChange={() => setChoice("structure")}
            className="mt-0.5"
          />
          <span className="flex flex-col">
            <span className="font-medium">Structure</span>
            <span className="text-xs text-muted-foreground">
              Schema, table and column names, types, keys, indexes and the server&apos;s statistics.
              No row of any table.
            </span>
          </span>
        </label>
        <label className={`flex items-start gap-2 text-sm ${dataReady ? "" : "opacity-70"}`}>
          <input
            type="radio"
            name={`claude-level-${connection.id}`}
            checked={choice === "data"}
            disabled={!dataReady}
            onChange={() => setChoice("data")}
            className="mt-0.5"
          />
          <span className="flex flex-col">
            <span className="font-medium">Structure and data</span>
            <span className="text-xs text-muted-foreground">
              Also rows and read-only queries (one statement, read-only transaction, limits).
              Columns with sensitive-looking names are never returned.
              {dataReady ? "" : " Turn on viewing table data for this connection first."}
            </span>
          </span>
        </label>
        {wantsData ? (
          <div className="ml-6 flex flex-col gap-2 rounded-md border p-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={approval}
                onChange={(event) => setApproval(event.target.checked)}
                className="mt-0.5"
              />
              <span className="flex flex-col">
                <span className="font-medium">Ask me before each call</span>
                <span className="text-xs text-muted-foreground">
                  Recommended. A statement or a page of rows runs only after you approve it.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={understood}
                onChange={(event) => setUnderstood(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                I understand that rows Claude reads are sent to Anthropic by the Claude app, and
                that this cannot be taken back.
              </span>
            </label>
          </div>
        ) : null}
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

      {shared && mine.length > 0 ? (
        <section
          className="flex flex-col gap-1"
          aria-labelledby={`claude-activity-${connection.id}`}
        >
          <h3 id={`claude-activity-${connection.id}`} className="text-sm font-medium">
            What Claude asked
          </h3>
          <ul className="flex max-h-40 flex-col gap-1 overflow-auto text-xs">
            {mine.map((c) => (
              <li key={c.id} className="flex flex-col rounded-md bg-muted p-1.5">
                <span className="font-mono break-words">{c.request || c.tool}</span>
                <span className="text-muted-foreground">
                  {OUTCOME_WORDS[c.outcome]}
                  {c.rows !== undefined ? `, ${c.rows} row${c.rows === 1 ? "" : "s"}` : ""}
                  {c.size !== undefined ? `, ${formatSize(c.size)}` : ""}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Only what was asked and how it ended: the rows that came back are not kept here.
          </p>
        </section>
      ) : null}

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
        ) : null}
        {riskyRole ? (
          <Button disabled={!canStart} onClick={() => void change("data", true)}>
            Share anyway
          </Button>
        ) : (
          <Button
            disabled={!canStart || (shared && level === choice && approval === current?.approval)}
            onClick={() => void change(choice)}
          >
            {shared
              ? "Update sharing"
              : wantsData
                ? "Start sharing the data"
                : "Start sharing the structure"}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

const OUTCOME_WORDS: Record<string, string> = {
  waiting: "waiting",
  ok: "answered",
  error: "failed",
  refused: "refused",
  not_approved: "not approved",
  paused: "paused",
  rate_limited: "too many calls",
};

const formatSize = (chars: number): string =>
  chars < 1024 ? `${chars} characters` : `${(chars / 1024).toFixed(1)} KB`;
