/**
 * The custom React Flow node that draws one table: a header, one row per
 * column (with key badges and a connection point on each side), and a footer to
 * expand a wide table.
 *
 * The node stores only its identity (see canvas-store). Everything it displays
 * comes from the metadata store, so the same table drawn twice, or after a
 * reload, always shows current structure.
 *
 * SIZES must match @datacanvas/canvas-engine/constants (40 px header, 26 px
 * rows, 30 px footer, 280 px wide): the layout code positions nodes before they
 * have ever been drawn, using those numbers.
 */
"use client";

import {
  hiddenColumnCount,
  columnHandleId,
  tableHandleId,
  visibleColumns,
  COLLAPSED_COLUMN_LIMIT,
} from "@datacanvas/canvas-engine";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AlertTriangle, KeyRound, Link2 } from "lucide-react";
import { KIND_ICON } from "@/components/relation-kind";
import { memo, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useCanvasStore, type TableFlowNode } from "@/stores/canvas-store";
import { useMetadataStore } from "@/stores/metadata-store";
import { useCanvasConnection } from "./canvas-context";

/** Small connection points. Always attached to the row, but only visible when hovering the node. */
const handleClass =
  "!size-2 !min-h-0 !min-w-0 !border-0 !bg-muted-foreground opacity-0 transition-opacity group-hover:opacity-100";

function TableNodeComponent({ id, data, selected }: NodeProps<TableFlowNode>) {
  const connectionId = useCanvasConnection();
  const entry = useMetadataStore((state) => state.byConnection[connectionId]?.tables[id]);
  const toggleExpanded = useCanvasStore((state) => state.toggleExpanded);

  // Which columns are part of a primary or foreign key, for the badges.
  const keys = useMemo(() => {
    const columnsOf = (kind: "primary_key" | "foreign_key"): Set<string> =>
      new Set((entry?.constraints ?? []).filter((c) => c.kind === kind).flatMap((c) => c.columns));
    return { primary: columnsOf("primary_key"), foreign: columnsOf("foreign_key") };
  }, [entry]);

  // A table a saved layout mentions but the database no longer has. Drawn as a
  // clear warning (no connection points, so no edges), and kept so nothing is lost.
  if (data.missing) {
    return (
      <div
        className={cn(
          "w-[280px] rounded-lg border-2 border-dashed border-destructive/60 bg-card text-card-foreground",
          selected && "ring-2 ring-ring",
        )}
      >
        <div className="flex h-10 items-center gap-2 px-3">
          <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
          <span className="truncate text-sm font-semibold">{data.name}</span>
          {data.schema !== "public" ? (
            <span className="truncate text-xs text-muted-foreground">{data.schema}</span>
          ) : null}
        </div>
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          This table no longer exists in the database. Select it and press Delete to remove it from
          the layout.
        </p>
      </div>
    );
  }

  const Icon = KIND_ICON[entry?.table.kind ?? "table"];
  const columnNames = entry?.columns.map((c) => c.name) ?? [];
  const shown = visibleColumns(columnNames, data.expanded);
  const hidden = hiddenColumnCount(columnNames.length, data.expanded);
  const canCollapse = data.expanded && columnNames.length > COLLAPSED_COLUMN_LIMIT;

  return (
    <div
      className={cn(
        "group w-[280px] overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm",
        selected && "ring-2 ring-ring",
      )}
    >
      <div className="relative flex h-10 items-center gap-2 border-b bg-muted px-3">
        {/* Fallback connection points, used when a column row is hidden. */}
        <Handle
          type="target"
          position={Position.Left}
          id={tableHandleId("target")}
          className={handleClass}
        />
        <Handle
          type="source"
          position={Position.Right}
          id={tableHandleId("source")}
          className={handleClass}
        />
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate text-sm font-semibold">{data.name}</span>
        {data.schema !== "public" ? (
          <span className="truncate text-xs text-muted-foreground">{data.schema}</span>
        ) : null}
      </div>

      {!entry ? (
        <div className="h-[26px] px-3 text-xs leading-[26px] text-muted-foreground">Loading…</div>
      ) : (
        shown.map((name) => {
          const column = entry.columns.find((c) => c.name === name);
          return (
            <div key={name} className="relative flex h-[26px] items-center gap-2 px-3 text-xs">
              <Handle
                type="target"
                position={Position.Left}
                id={columnHandleId("target", name)}
                className={handleClass}
              />
              <Handle
                type="source"
                position={Position.Right}
                id={columnHandleId("source", name)}
                className={handleClass}
              />
              <span className="flex w-4 shrink-0 justify-center">
                {keys.primary.has(name) ? (
                  <KeyRound className="size-3 text-amber-500" aria-label="primary key" />
                ) : keys.foreign.has(name) ? (
                  <Link2 className="size-3 text-sky-500" aria-label="foreign key" />
                ) : null}
              </span>
              <span className={cn("truncate", column?.nullable === false && "font-medium")}>
                {name}
              </span>
              <span className="ml-auto max-w-[45%] truncate text-muted-foreground">
                {column?.dataType}
              </span>
            </div>
          );
        })
      )}

      {hidden > 0 || canCollapse ? (
        <button
          type="button"
          // "nodrag nopan": clicking the button must not start dragging the node or panning the canvas.
          className="nodrag nopan flex h-[30px] w-full items-center justify-center border-t text-xs text-muted-foreground hover:bg-accent"
          onClick={() => toggleExpanded(connectionId, id)}
        >
          {data.expanded
            ? "Show fewer columns"
            : `+ ${hidden} more column${hidden === 1 ? "" : "s"}`}
        </button>
      ) : null}
    </div>
  );
}

/** Memoised: React Flow re-renders nodes often, and a node only changes when its props do. */
export const TableNode = memo(TableNodeComponent);
