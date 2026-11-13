/**
 * The toolbar floating over the canvas: search, layout, filters, relationship
 * exploration, selection actions, the grid, the inspector and export.
 */
"use client";

import type { Direction } from "@datacanvas/canvas-engine";
import {
  Download,
  Filter,
  Grid3x3,
  LayoutGrid,
  Loader2,
  MousePointerSquareDashed,
  PanelRight,
  Trash2,
  Waypoints,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCanvasStore } from "@/stores/canvas-store";
import { MAX_FOCUS_HOPS, useCanvasViewStore, viewOf } from "@/stores/canvas-view-store";
import { CanvasSearch } from "./canvas-search";
import { addRelatedTables } from "./explore-actions";
import { applyLayout, type LayoutChoice } from "./layout-actions";

interface CanvasToolbarProps {
  connectionId: string;
  gridVisible: boolean;
  onToggleGrid: () => void;
  /** Tables currently hidden by a filter or by focus mode. */
  hiddenIds: ReadonlySet<string>;
  onExport: () => void;
}

const LAYOUTS: Array<{ choice: LayoutChoice; label: string; hint: string }> = [
  { choice: "hierarchical", label: "Hierarchical", hint: "Relationships flow left to right" },
  {
    choice: "grouped",
    label: "Group related tables",
    hint: "Each cluster together, clusters apart",
  },
  { choice: "compact", label: "Compact", hint: "Pack tightly, ignore relationships" },
  { choice: "grid", label: "Simple grid", hint: "Tidy rows" },
];

const DIRECTIONS: Array<{ value: Direction; label: string }> = [
  { value: "both", label: "Both ways" },
  { value: "outgoing", label: "References (parents)" },
  { value: "incoming", label: "Referenced by (children)" },
];

export function CanvasToolbar({
  connectionId,
  gridVisible,
  onToggleGrid,
  hiddenIds,
  onExport,
}: CanvasToolbarProps) {
  const nodes = useCanvasStore((s) => s.canvases[connectionId]?.nodes);
  const busy = useCanvasStore((s) => s.busy);
  const error = useCanvasStore((s) => s.error);
  const view = useCanvasViewStore((s) => viewOf(s.views, connectionId));
  const viewActions = useCanvasViewStore.getState();
  const { selectAll, removeSelected } = useCanvasStore.getState();

  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const tableCount = nodes?.length ?? 0;
  const selected = nodes?.filter((n) => n.selected && !hiddenIds.has(n.id)) ?? [];
  const shownCount = tableCount - hiddenIds.size;
  const schemas = useMemo(
    () => [...new Set((nodes ?? []).map((n) => n.data.schema))].sort(),
    [nodes],
  );
  const filtersActive =
    view.filters.hiddenSchemas.length > 0 ||
    !view.filters.showViews ||
    view.filters.hiddenIds.length > 0 ||
    !view.relationshipTypes.manyToOne ||
    !view.relationshipTypes.oneToOne;

  async function run(work: () => Promise<{ ok: boolean; message?: string }>, success?: string) {
    setMessage(null);
    setWorking(true);
    const result = await work();
    setWorking(false);
    setMessage(result.ok ? (success ?? null) : (result.message ?? "That did not work."));
  }

  /** Keep a menu open when a checkbox or radio item is chosen, so several can be changed in a row. */
  const keepOpen = (event: Event) => event.preventDefault();

  return (
    <div className="flex max-w-[calc(100vw-22rem)] flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-background/90 p-1.5 shadow-sm backdrop-blur">
        <CanvasSearch connectionId={connectionId} />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={tableCount === 0}
              title="Arrange the tables automatically"
            >
              <LayoutGrid aria-hidden="true" />
              Layout
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-64">
            <DropdownMenuLabel>Arrange all tables</DropdownMenuLabel>
            {LAYOUTS.map(({ choice, label, hint }) => (
              <DropdownMenuItem
                key={choice}
                onSelect={() => void run(() => applyLayout(connectionId, choice))}
              >
                <span className="flex flex-col">
                  <span>{label}</span>
                  <span className="text-xs text-muted-foreground">{hint}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={filtersActive ? "secondary" : "ghost"}
              size="sm"
              disabled={tableCount === 0}
            >
              <Filter aria-hidden="true" />
              Filters{filtersActive ? " •" : ""}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-64">
            <DropdownMenuLabel>Show schemas</DropdownMenuLabel>
            {schemas.map((schema) => (
              <DropdownMenuCheckboxItem
                key={schema}
                checked={!view.filters.hiddenSchemas.includes(schema)}
                onSelect={keepOpen}
                onCheckedChange={() => viewActions.toggleSchema(connectionId, schema)}
              >
                {schema}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={view.filters.showViews}
              onSelect={keepOpen}
              onCheckedChange={(checked) => viewActions.setShowViews(connectionId, checked)}
            >
              Show views and materialized views
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Show relationships</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={view.relationshipTypes.manyToOne}
              onSelect={keepOpen}
              onCheckedChange={(checked) =>
                viewActions.setRelationshipType(connectionId, "manyToOne", checked)
              }
            >
              Many-to-one (N:1)
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={view.relationshipTypes.oneToOne}
              onSelect={keepOpen}
              onCheckedChange={(checked) =>
                viewActions.setRelationshipType(connectionId, "oneToOne", checked)
              }
            >
              One-to-one (1:1)
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={view.filters.hiddenIds.length === 0}
              onSelect={() => viewActions.showAllTables(connectionId)}
            >
              Show {view.filters.hiddenIds.length} hidden table
              {view.filters.hiddenIds.length === 1 ? "" : "s"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!filtersActive && view.focus.mode === "off"}
              onSelect={() => viewActions.resetFilters(connectionId)}
            >
              Reset filters and focus
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={view.focus.mode !== "off" ? "secondary" : "ghost"}
              size="sm"
              disabled={tableCount === 0}
            >
              <Waypoints aria-hidden="true" />
              Explore{view.focus.mode !== "off" ? " •" : ""}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-72">
            <DropdownMenuLabel>
              {selected.length === 0
                ? "Select a table first"
                : `${selected.length} table${selected.length === 1 ? "" : "s"} selected`}
            </DropdownMenuLabel>
            <DropdownMenuItem
              disabled={selected.length === 0}
              onSelect={() =>
                void run(async () => {
                  const result = await addRelatedTables(connectionId, {
                    hops: view.focus.hops,
                    direction: view.focus.direction,
                  });
                  return result;
                })
              }
            >
              Add related tables ({view.focus.hops} {view.focus.hops === 1 ? "hop" : "hops"})
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={selected.length === 0}
              onSelect={() =>
                viewActions.hideTables(
                  connectionId,
                  selected.map((n) => n.id),
                )
              }
            >
              Hide selected tables
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Focus on the selection</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={view.focus.mode}
              onValueChange={(mode) =>
                viewActions.setFocus(connectionId, { mode: mode as "off" | "dim" | "hide" })
              }
            >
              <DropdownMenuRadioItem value="off" onSelect={keepOpen}>
                Off
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dim" onSelect={keepOpen}>
                Dim unrelated tables
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="hide" onSelect={keepOpen}>
                Hide unrelated tables
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>How far (relationships away)</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={String(view.focus.hops)}
              onValueChange={(hops) => viewActions.setFocus(connectionId, { hops: Number(hops) })}
            >
              {Array.from({ length: MAX_FOCUS_HOPS }, (_v, i) => i + 1).map((hops) => (
                <DropdownMenuRadioItem key={hops} value={String(hops)} onSelect={keepOpen}>
                  {hops} {hops === 1 ? "hop" : "hops"}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Which direction</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={view.focus.direction}
              onValueChange={(direction) =>
                viewActions.setFocus(connectionId, { direction: direction as Direction })
              }
            >
              {DIRECTIONS.map((d) => (
                <DropdownMenuRadioItem key={d.value} value={d.value} onSelect={keepOpen}>
                  {d.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => selectAll(connectionId, hiddenIds)}
          disabled={shownCount === 0}
          title="Select every visible table"
        >
          <MousePointerSquareDashed aria-hidden="true" />
          Select all
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => removeSelected(connectionId, hiddenIds)}
          disabled={selected.length === 0}
          title="Remove the selected tables from the canvas (the database is not touched)"
        >
          <Trash2 aria-hidden="true" />
          Remove{selected.length > 0 ? ` (${selected.length})` : ""}
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
        <Button
          variant={view.inspectorOpen ? "secondary" : "ghost"}
          size="sm"
          onClick={() => viewActions.setInspectorOpen(connectionId, !view.inspectorOpen)}
          aria-pressed={view.inspectorOpen}
          title="Show or hide the inspector panel"
        >
          <PanelRight aria-hidden="true" />
          Inspector
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onExport}
          disabled={shownCount === 0}
          title="Save the diagram as an image"
        >
          <Download aria-hidden="true" />
          Export
        </Button>

        <span className="px-2 text-xs text-muted-foreground" aria-live="polite">
          {busy || working ? (
            <Loader2 className="inline size-3.5 animate-spin" aria-label="Working" />
          ) : hiddenIds.size > 0 ? (
            `${shownCount} of ${tableCount} tables`
          ) : (
            `${tableCount} table${tableCount === 1 ? "" : "s"}`
          )}
        </span>
      </div>

      {error || message ? (
        <p
          role={error ? "alert" : "status"}
          className={`rounded-lg border bg-background/90 px-3 py-2 text-sm shadow-sm backdrop-blur ${error ? "border-destructive/30 text-destructive" : ""}`}
        >
          {error ?? message}
        </p>
      ) : null}
    </div>
  );
}
