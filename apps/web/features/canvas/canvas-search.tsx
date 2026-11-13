/**
 * The canvas search box. Finds tables AND columns, both among the tables already
 * on the canvas (instantly) and anywhere in the database (after a short pause,
 * from the server). Choosing a result jumps to it, adding the table to the
 * canvas first if it is not there yet.
 */
"use client";

import { nodeIdFor, searchTables } from "@datacanvas/canvas-engine";
import type { SearchHit } from "@datacanvas/database-core";
import { Loader2, Search, Type, type LucideIcon } from "lucide-react";
import { KIND_ICON } from "@/components/relation-kind";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { searchObjects } from "@/features/explorer/api";
import { useAsyncData } from "@/lib/use-async-data";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "@/stores/canvas-store";
import { addTablesToCanvas } from "./add-tables";

/** One row in the result list. */
interface Result {
  key: string;
  label: string;
  detail: string;
  icon: LucideIcon;
  onCanvas: boolean;
  open: () => void;
}

const HIT_ICON = { ...KIND_ICON, column: Type } as const;

export function CanvasSearch({ connectionId }: { connectionId: string }) {
  const nodes = useCanvasStore((s) => s.canvases[connectionId]?.nodes);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Wait until the user pauses before asking the server: one request per word, not per keystroke.
  const settled = useDebouncedValue(query.trim(), 250);
  const remote = useAsyncData<SearchHit[]>(
    () =>
      settled === ""
        ? Promise.resolve({ ok: true, data: [] })
        : searchObjects(connectionId, settled, 8),
    `${connectionId}/${settled}`,
  );

  const results = useMemo<Result[]>(() => {
    const store = useCanvasStore.getState();
    const onCanvas = new Set((nodes ?? []).map((n) => n.id));
    const jump = (id: string) => {
      store.selectOnly(connectionId, id);
      store.requestFocus(connectionId, id);
      setQuery("");
    };

    // 1. Tables already on the canvas: instant, no server needed.
    const local = searchTables(
      query,
      (nodes ?? []).map((n) => ({
        id: n.id,
        label: n.data.schema === "public" ? n.data.name : `${n.data.schema}.${n.data.name}`,
      })),
      5,
    ).map((m): Result => ({
      key: `canvas:${m.id}`,
      label: m.label,
      detail: "on the canvas",
      icon: KIND_ICON.table,
      onCanvas: true,
      open: () => jump(m.id),
    }));

    // 2. Anywhere in the database (tables, views and columns), from the server.
    const hits =
      remote.state.status === "success" && settled === query.trim() ? remote.state.data : [];
    const database = hits.flatMap((hit): Result[] => {
      const id = nodeIdFor({ schema: hit.schema, name: hit.table });
      const qualified = hit.schema === "public" ? hit.table : `${hit.schema}.${hit.table}`;
      // A table that is already shown is listed once, in the first group.
      if (hit.kind !== "column" && onCanvas.has(id)) return [];
      return [
        {
          key: `db:${hit.kind}:${hit.schema}.${hit.table}.${hit.column ?? ""}`,
          label: hit.column ? `${qualified}.${hit.column}` : qualified,
          detail: hit.column
            ? `column, ${hit.dataType}${onCanvas.has(id) ? ", table on canvas" : ""}`
            : `${hit.kind.replace("_", " ")}, add to canvas`,
          icon: HIT_ICON[hit.kind],
          onCanvas: onCanvas.has(id),
          open: () => {
            setQuery("");
            if (onCanvas.has(id)) jump(id);
            else
              void addTablesToCanvas(connectionId, [{ schema: hit.schema, name: hit.table }], {
                focus: true,
              });
          },
        },
      ];
    });
    return [...local, ...database];
  }, [nodes, query, remote.state, settled, connectionId]);

  const searching =
    query.trim() !== "" && (settled !== query.trim() || remote.state.status === "loading");
  const showList = query.trim() !== "";
  const current = Math.min(active, Math.max(results.length - 1, 0));

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        role="combobox"
        aria-expanded={showList}
        aria-controls="canvas-search-results"
        aria-autocomplete="list"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setQuery("");
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") results[current]?.open();
        }}
        placeholder="Find a table or column"
        aria-label="Find a table or column"
        className="h-7 w-56 pl-7 text-sm"
      />
      {searching ? (
        <Loader2
          className="absolute top-1/2 right-2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
          aria-label="Searching"
        />
      ) : null}

      {showList ? (
        <ul
          id="canvas-search-results"
          role="listbox"
          aria-label="Search results"
          className="absolute top-8 left-0 z-20 max-h-80 w-80 overflow-y-auto rounded-md border bg-popover text-sm shadow-md"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">
              {searching ? "Searching…" : "No matching table or column."}
            </li>
          ) : (
            results.map((result, index) => {
              const Icon = result.icon;
              return (
                <li key={result.key} role="option" aria-selected={index === current}>
                  <button
                    type="button"
                    onClick={result.open}
                    onMouseEnter={() => setActive(index)}
                    className={cn(
                      "flex w-full items-center gap-2 px-2 py-1.5 text-left",
                      index === current && "bg-accent",
                    )}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{result.label}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{result.detail}</span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
