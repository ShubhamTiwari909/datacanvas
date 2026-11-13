/**
 * The interactive canvas for one connection: pan, zoom, drag tables, select,
 * minimap, grid, and the toolbar. Built on React Flow (@xyflow/react), which
 * provides the viewport, dragging and selection; the table nodes, edges and
 * layout are ours.
 *
 * REMINDERS about coordinates: a node's `position` is in CANVAS space (a big
 * plane that does not change when you pan or zoom). The viewport is the window
 * onto that plane: `screen = canvas * zoom + pan`. React Flow keeps the
 * viewport internally; it is not stored here (a saved workspace records it when saving).
 */
"use client";

import "@xyflow/react/dist/style.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  getNodesBounds,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type NodeTypes,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ensureWorkspaceLoaded } from "@/features/workspaces/workspace-actions";
import { WorkspaceBar } from "@/features/workspaces/workspace-bar";
import { useCanvasStore, type TableFlowNode } from "@/stores/canvas-store";
import { usePersistenceStore } from "@/stores/persistence-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { CanvasConnectionProvider } from "./canvas-context";
import { CanvasToolbar } from "./canvas-toolbar";
import { TableNode } from "./table-node";
import { ExportDialog } from "./export-dialog";
import { exportCanvasImage, type ImageFormat } from "./export-image";
import { InspectorPanel } from "./inspector-panel";
import { useCanvasDisplay } from "./use-canvas-edges";

// Defined once at module level: React Flow compares this object by identity, and
// a new object on every render would make it re-create every node.
const nodeTypes: NodeTypes = { table: TableNode };
const NO_NODES: TableFlowNode[] = [];

function CanvasInner({ connectionId }: { connectionId: string }) {
  const nodes = useCanvasStore((s) => s.canvases[connectionId]?.nodes) ?? NO_NODES;
  const layoutVersion = useCanvasStore((s) => s.canvases[connectionId]?.layoutVersion ?? 0);
  const restoreVersion = useCanvasStore((s) => s.canvases[connectionId]?.restoreVersion ?? 0);
  // Read once, at mount: lets a remounted canvas (after visiting "Table details") reopen where it was.
  const [initialViewport] = useState(
    () => useCanvasStore.getState().canvases[connectionId]?.viewport ?? undefined,
  );
  const focusRequest = useCanvasStore((s) => s.focusRequest);
  const busy = useCanvasStore((s) => s.busy);
  const display = useCanvasDisplay(connectionId);
  const edges = display.edges;
  const workspaceName = usePersistenceStore((s) => s.active[connectionId]?.name);
  const containerRef = useRef<HTMLDivElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState<ImageFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // What is drawn: tables hidden by a filter or by focus mode are marked hidden, tables outside the
  // focus are faded. Untouched nodes are passed through as they are, so dragging stays cheap.
  const displayNodes = useMemo(() => {
    if (display.hiddenIds.size === 0 && display.dimmedIds.size === 0) return nodes;
    return nodes.map((node) => {
      const hidden = display.hiddenIds.has(node.id);
      const dimmed = display.dimmedIds.has(node.id);
      if (Boolean(node.hidden) === hidden && (node.style?.opacity === 0.18) === dimmed) return node;
      return { ...node, hidden, style: dimmed ? { opacity: 0.18 } : undefined };
    });
  }, [nodes, display.hiddenIds, display.dimmedIds]);

  async function exportImage(format: ImageFormat) {
    const element = containerRef.current?.querySelector<HTMLElement>(".react-flow__viewport");
    const visible = nodes.filter((n) => !display.hiddenIds.has(n.id));
    if (!element || visible.length === 0) return;
    setExporting(format);
    setExportError(null);
    try {
      await exportCanvasImage(
        format,
        element,
        getNodesBounds(visible),
        workspaceName ?? "datacanvas",
      );
      setExportOpen(false);
    } catch {
      setExportError("The image could not be created. Try the other format, or show fewer tables.");
    } finally {
      setExporting(null);
    }
  }

  const [gridVisible, setGridVisible] = useState(true);

  const { fitView, setViewport } = useReactFlow<TableFlowNode>();
  // True once every node has been drawn and measured. Fitting the view before that would use wrong sizes.
  const nodesInitialized = useNodesInitialized();
  // Start from the current versions: on a REMOUNT nothing should be refitted or re-applied.
  const fittedVersion = useRef(layoutVersion);
  const restoredVersion = useRef(restoreVersion);

  // When a connection's canvas is first shown, open its saved layout (if it has one).
  useEffect(() => {
    void ensureWorkspaceLoaded(connectionId);
  }, [connectionId]);

  // A saved layout was applied: put the pan and zoom back exactly as saved (no animation).
  useEffect(() => {
    if (restoredVersion.current === restoreVersion) return;
    restoredVersion.current = restoreVersion;
    const viewport = useCanvasStore.getState().canvases[connectionId]?.viewport;
    if (viewport) void setViewport(viewport, { duration: 0 });
  }, [restoreVersion, connectionId, setViewport]);

  // Fit everything on screen when the whole layout changed (first tables added, or "reset layout").
  useEffect(() => {
    if (nodesInitialized && fittedVersion.current !== layoutVersion) {
      fittedVersion.current = layoutVersion;
      void fitView({ padding: 0.2, maxZoom: 1, duration: 300 });
    }
  }, [nodesInitialized, layoutVersion, fitView]);

  // Pan and zoom to a table when asked (search, or clicking it in the sidebar).
  useEffect(() => {
    const { focusRequest: request, clearFocus } = useCanvasStore.getState();
    if (!request || request.connectionId !== connectionId || !nodesInitialized) return;
    if (!nodes.some((n) => n.id === request.nodeId)) return;
    useCanvasStore.getState().selectOnly(connectionId, request.nodeId);
    void fitView({ nodes: [{ id: request.nodeId }], padding: 0.6, maxZoom: 1, duration: 400 });
    clearFocus();
  }, [focusRequest, nodesInitialized, nodes, connectionId, fitView]);

  return (
    <div className="flex h-full w-full flex-col" data-testid="canvas">
      <WorkspaceBar connectionId={connectionId} />
      <div className="flex min-h-0 flex-1">
        <div ref={containerRef} className="min-w-0 flex-1">
          <ReactFlow<TableFlowNode>
            nodes={displayNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) =>
              useCanvasStore.getState().applyChanges(connectionId, changes)
            }
            onNodeDoubleClick={(_event, node) => {
              const workspace = useWorkspaceStore.getState();
              workspace.selectTable({ schema: node.data.schema, name: node.data.name });
              workspace.setView("details");
            }}
            defaultViewport={initialViewport}
            // Remember where the user has panned and zoomed to (saved with the workspace).
            onMoveEnd={(_event, viewport) =>
              useCanvasStore.getState().setViewport(connectionId, viewport)
            }
            minZoom={0.05}
            maxZoom={2}
            // Tables are never connected by dragging: relationships come from the database.
            nodesConnectable={false}
            deleteKeyCode={["Backspace", "Delete"]}
            // With hundreds of tables, only draw what is on screen.
            onlyRenderVisibleElements
            colorMode="light"
            aria-label="Database canvas"
          >
            {gridVisible ? (
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
            ) : null}
            <MiniMap pannable zoomable ariaLabel="Overview of all tables" />
            <Controls showInteractive={false} />
            <Panel position="top-left">
              <CanvasToolbar
                connectionId={connectionId}
                gridVisible={gridVisible}
                onToggleGrid={() => setGridVisible((v) => !v)}
                hiddenIds={display.hiddenIds}
                onExport={() => {
                  setExportError(null);
                  setExportOpen(true);
                }}
              />
            </Panel>
            {nodes.length === 0 && !busy ? (
              // Centered over the canvas and click-through, so it never covers the toolbar or blocks panning.
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="rounded-lg border bg-background/90 p-6 text-center shadow-sm backdrop-blur">
                  <h2 className="text-lg font-semibold">The canvas is empty</h2>
                  <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                    Click a table in the sidebar to add it, or use the grid button next to a schema
                    to add all of its tables.
                  </p>
                </div>
              </div>
            ) : null}
          </ReactFlow>
        </div>
        <InspectorPanel connectionId={connectionId} hiddenIds={display.hiddenIds} />
      </div>
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        onExport={(format) => void exportImage(format)}
        exporting={exporting}
        error={exportError}
        tableCount={nodes.length - display.hiddenIds.size}
      />
    </div>
  );
}

export function CanvasView({ connectionId }: { connectionId: string }) {
  return (
    <CanvasConnectionProvider value={connectionId}>
      {/* The provider gives the hooks above access to the same React Flow instance. */}
      <ReactFlowProvider>
        <CanvasInner connectionId={connectionId} />
      </ReactFlowProvider>
    </CanvasConnectionProvider>
  );
}
