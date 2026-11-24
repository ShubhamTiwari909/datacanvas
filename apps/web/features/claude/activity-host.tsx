/**
 * Mounted once in the app shell (decision 169): while anything is shared with Claude it asks the server what Claude is doing,
 * and when a call waits for the person's Approve it puts it in front of them. Nothing runs before Approve.
 */
"use client";

import { useEffect } from "react";
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

/** How often the state is read while something is shared. */
const POLL_MS = 1500;

export function ClaudeActivityHost() {
  const anyShared = useClaudeStore((s) => Object.values(s.sharing).some((c) => c.level !== "off"));
  const refresh = useClaudeStore((s) => s.refresh);
  const decide = useClaudeStore((s) => s.decide);
  const setPaused = useClaudeStore((s) => s.setPaused);
  const pending = useClaudeStore((s) => s.activity?.pending[0] ?? null);
  const more = useClaudeStore((s) => Math.max(0, (s.activity?.pending.length ?? 0) - 1));

  useEffect(() => {
    if (!anyShared) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyShared, refresh]);

  return (
    // Escape or a click outside does not answer: only Approve or Deny does (a stray key must not approve, and does not deny).
    <Dialog open={pending !== null} onOpenChange={() => {}}>
      {pending ? (
        <DialogContent
          size="form"
          showCloseButton={false}
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>
              Claude wants to read{pending.connectionName ? ` ${pending.connectionName}` : ""}
            </DialogTitle>
            <DialogDescription>
              {pending.tool === "read_rows"
                ? "Claude is asking for a page of rows of this table."
                : pending.tool === "explain_query"
                  ? "Claude is asking for the plan of this statement (it is not run)."
                  : "Claude is asking to run this read-only statement."}{" "}
              Nothing runs until you approve.
            </DialogDescription>
          </DialogHeader>
          <pre
            tabIndex={0}
            aria-label="What Claude asked"
            className="max-h-60 overflow-auto rounded-md bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap"
          >
            {pending.request}
          </pre>
          {more > 0 ? (
            <p className="text-xs text-muted-foreground">
              {more} more request{more === 1 ? " is" : "s are"} waiting after this one.
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => void setPaused(true)}>
              Pause Claude
            </Button>
            <Button variant="outline" onClick={() => void decide(pending.id, "deny")}>
              Deny
            </Button>
            <Button onClick={() => void decide(pending.id, "approve")}>Approve</Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
