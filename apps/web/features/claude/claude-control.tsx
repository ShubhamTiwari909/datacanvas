/** The "Claude" line under a connection in the sidebar (decision 169): what is shared, and the way to change it. */
"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import type { ConnectionSummary } from "@datacanvas/shared-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useClaudeLevel, useClaudeStore } from "@/stores/claude-store";
import { ShareWithClaudeDialog } from "./share-dialog";

export function ClaudeControl({ connection }: { connection: ConnectionSummary }) {
  const level = useClaudeLevel(connection.id);
  const load = useClaudeStore((s) => s.load);
  const [open, setOpen] = useState(false);

  // The server forgets a sharing on its own (data viewing switched off takes the data level back): ask again then.
  useEffect(() => {
    void load(connection.id);
  }, [connection.id, connection.dataAccess, load]);

  return (
    <div className="flex items-center gap-2 px-2 pb-1">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => setOpen(true)}
        // The name starts with the words on the button (WCAG 2.5.3), then says which connection.
        aria-label={
          level === "off"
            ? `Share with Claude: ${connection.name}`
            : `Shared with Claude: ${connection.name}, ${level} level. Change or stop`
        }
      >
        <Sparkles aria-hidden="true" />
        {level === "off" ? "Share with Claude" : "Shared with Claude"}
      </Button>
      {level !== "off" ? <Badge variant="outline">{level}</Badge> : null}
      <ShareWithClaudeDialog connection={connection} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
