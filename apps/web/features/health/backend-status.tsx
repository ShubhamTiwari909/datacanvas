/**
 * Small indicator for the header: "Backend status: Connected".
 * A Client Component because it uses a hook that talks to the server.
 */
"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useBackendStatus, type BackendStatus as Status } from "./use-backend-status";

const LABELS: Record<Status, string> = {
  checking: "Checking…",
  connected: "Connected",
  unreachable: "Unreachable",
};

const DOT_STYLES: Record<Status, string> = {
  checking: "bg-muted-foreground animate-pulse",
  connected: "bg-emerald-500",
  unreachable: "bg-destructive",
};

export function BackendStatus() {
  const { status, retry } = useBackendStatus();

  return (
    // role="status" lets screen readers announce changes politely.
    <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className={cn("size-2 rounded-full", DOT_STYLES[status])} aria-hidden="true" />
      <span>
        {/* The prefix is hidden on very small screens to keep the header uncluttered. */}
        <span className="hidden sm:inline">Backend status: </span>
        {LABELS[status]}
      </span>
      {status === "unreachable" ? (
        <Button variant="link" size="sm" onClick={retry} className="h-auto p-0">
          Retry
        </Button>
      ) : null}
    </div>
  );
}
