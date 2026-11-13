/**
 * The toolbar floating over the canvas: search, reset layout, grid toggle,
 * select all, remove selected, and add/progress feedback.
 */
"use client";

import { nodeIdFor, searchTables } from "@datacanvas/canvas-engine";
import {
  Grid3x3,
  LayoutGrid,
  Loader2,
  MousePointerSquareDashed,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCanvasStore } from "@/stores/canvas-store";

interface CanvasToolbarProps {
  connectionId: string;
  gridVisible: boolean;
  onToggleGrid: () => void;
}

export function CanvasToolbar({ connectionId, gridVisible, onToggleGrid }: CanvasToolbarProps) {
  const nodes = useCanvasStore((s) => s.canvases[connectionId]?.nodes);
  const busy = useCanvasStore((s) => s.busy);
  const error = useCanvasStore((s) => s.error);
  const { resetLayout, selectAll, removeSelected, selectOnly, requestFocus } =
    useCanvasStore.getState();

  const [query, setQuery] = useState("");
  const tableCount = nodes?.length ?? 0;
  const selectedCount = nodes?.filter((n) => n.selected).length ?? 0;

  const matches = useMemo(
    () =>
      searchTables(
        query,
        (nodes ?? []).map((n) => ({
          id: n.id,
          label: n.data.schema === "public" ? n.data.name : `${n.data.schema}.${n.data.name}`,
        })),
      ),
    [query, nodes],
  );

  function jumpTo(id: string) {
    selectOnly(connectionId, id);
    requestFocus(connectionId, id);
    setQuery("");
  }

  return (
    <div className="flex max-w-[calc(100vw-20rem)] flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-background/90 p-1.5 shadow-sm backdrop-blur">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) jumpTo(matches[0].id);
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Find a table on the canvas"
            aria-label="Find a table on the canvas"
            className="h-7 w-52 pl-7 text-sm"
          />
          {matches.length > 0 ? (
            <ul
              role="listbox"
              aria-label="Matching tables"
              className="absolute top-8 left-0 z-10 w-full overflow-hidden rounded-md border bg-popover text-sm shadow-md"
            >
              {matches.map((m) => (
                <li key={m.id} role="option" aria-selected="false">
                  <button
                    type="button"
                    className="w-full truncate px-2 py-1.5 text-left hover:bg-accent"
                    onClick={() => jumpTo(m.id)}
                  >
                    {m.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => resetLayout(connectionId)}
          disabled={tableCount === 0}
          title="Arrange all tables in a grid"
        >
          <LayoutGrid aria-hidden="true" />
          Reset layout
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => selectAll(connectionId)}
          disabled={tableCount === 0}
          title="Select every table (Ctrl/Cmd+A is not bound; use this)"
        >
          <MousePointerSquareDashed aria-hidden="true" />
          Select all
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => removeSelected(connectionId)}
          disabled={selectedCount === 0}
          title="Remove the selected tables from the canvas (the database is not touched)"
        >
          <Trash2 aria-hidden="true" />
          Remove{selectedCount > 0 ? ` (${selectedCount})` : ""}
        </Button>
        <Button
          variant={gridVisible ? "secondary" : "ghost"}
          size="sm"
          onClick={onToggleGrid}
          aria-pressed={gridVisible}
          title="Show or hide the background grid"
        >
          <Grid3x3 aria-hidden="true" />
          Grid
        </Button>
        <span className="px-2 text-xs text-muted-foreground" aria-live="polite">
          {busy ? (
            <Loader2 className="inline size-3.5 animate-spin" aria-label="Loading" />
          ) : (
            `${tableCount} table${tableCount === 1 ? "" : "s"}`
          )}
        </span>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-background/90 px-3 py-2 text-sm text-destructive shadow-sm backdrop-blur"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

// Re-exported so tests and other modules can derive the same node id without importing the engine.
export { nodeIdFor };
