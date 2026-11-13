/**
 * The interactive canvas for one connection: pan, zoom, drag tables, select,
 * minimap, grid, and the toolbar. Built on React Flow (@xyflow/react), which
 * provides the viewport, dragging and selection; the table nodes, edges and
 * layout are ours.
 *
 * REMINDERS about coordinates: a node's `position` is in CANVAS space (a big
 * plane that does not change when you pan or zoom). The viewport is the window
 * onto that plane: `screen = canvas * zoom + pan`. React Flow keeps the
 * viewport internally; we never store it here (Phase 8 will save it).
 */
"use client";

import "@xyflow/react/dist/style.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type NodeTypes,
} from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import { useCanvasStore, type TableFlowNode } from "@/stores/canvas-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { CanvasConnectionProvider } from "./canvas-context";
import { CanvasToolbar } from "./canvas-toolbar";
import { TableNode } from "./table-node";
import { useCanvasEdges } from "./use-canvas-edges";

// Defined once at module level: React Flow compares this object by identity, and
// a new object on every render would make it re-create every node.
const nodeTypes: NodeTypes = { table: TableNode };
const NO_NODES: TableFlowNode[] = [];

function CanvasInner({ connectionId }: { connectionId: string }) {
  const nodes = useCanvasStore((s) => s.canvases[connectionId]?.nodes) ?? NO_NODES;
  const layoutVersion = useCanvasStore((s) => s.canvases[connectionId]?.layoutVersion ?? 0);
  const focusRequest = useCanvasStore((s) => s.focusRequest);
  const busy = useCanvasStore((s) => s.busy);
  const edges = useCanvasEdges(connectionId);

  const [gridVisible, setGridVisible] = useState(true);

  const { fitView } = useReactFlow<TableFlowNode>();
  // True once every node has been drawn and measured. Fitting the view before that would use wrong sizes.
  const nodesInitialized = useNodesInitialized();
  const fittedVersion = useRef(0);

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
    <div className="h-full w-full" data-testid="canvas">
      <ReactFlow<TableFlowNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes) => useCanvasStore.getState().applyChanges(connectionId, changes)}
        onNodeDoubleClick={(_event, node) => {
          const workspace = useWorkspaceStore.getState();
          workspace.selectTable({ schema: node.data.schema, name: node.data.name });
          workspace.setView("details");
        }}
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
        {gridVisible ? <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} /> : null}
        <MiniMap pannable zoomable ariaLabel="Overview of all tables" />
        <Controls showInteractive={false} />
        <Panel position="top-left">
          <CanvasToolbar
            connectionId={connectionId}
            gridVisible={gridVisible}
            onToggleGrid={() => setGridVisible((v) => !v)}
          />
        </Panel>
        {nodes.length === 0 && !busy ? (
          // Centered over the canvas and click-through, so it never covers the toolbar or blocks panning.
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-lg border bg-background/90 p-6 text-center shadow-sm backdrop-blur">
              <h2 className="text-lg font-semibold">The canvas is empty</h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Click a table in the sidebar to add it, or use the grid button next to a schema to
                add all of its tables.
              </p>
            </div>
          </div>
        ) : null}
      </ReactFlow>
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
