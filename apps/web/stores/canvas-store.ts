/**
 * The canvas LAYOUT state: which tables are on the canvas of each connection,
 * where they are, whether they are expanded, and which are selected.
 *
 * It deliberately holds NO database metadata (columns, types, ...); nodes read
 * that from the metadata store. What is here is exactly what a saved workspace
 * will need to remember (Phase 8).
 *
 * Edges are NOT stored: they are derived from the relationships and the tables
 * currently on the canvas (see features/canvas/use-canvas-edges.ts), so there is
 * nothing to keep in sync when tables are added or removed.
 *
 * Nodes are React Flow `Node` objects (the library needs that shape), and
 * changes made by dragging, selecting or measuring arrive as `NodeChange`s
 * that `applyNodeChanges` folds into the node list.
 */
import {
  estimateNodeHeight,
  gridLayout,
  nextFreePosition,
  nodeIdFor,
  NODE_WIDTH,
  type Rect,
} from "@datacanvas/canvas-engine";
import type { TableRef } from "@datacanvas/database-core";
import { applyNodeChanges, type Node, type NodeChange } from "@xyflow/react";
import { create } from "zustand";

/** What is stored per table node. Identity and view state only. */
export interface TableNodeData extends Record<string, unknown> {
  schema: string;
  name: string;
  expanded: boolean;
  /** Only used to ESTIMATE the node's height for layout before it has been drawn. */
  columnCount: number;
}

export type TableFlowNode = Node<TableNodeData, "table">;

interface CanvasState {
  nodes: TableFlowNode[];
  /** Bumped when the whole layout changes, so the view knows to fit everything on screen. */
  layoutVersion: number;
}

/** A table to add, with the number of columns it has (for layout estimates). */
export interface NewTable {
  ref: TableRef;
  columnCount: number;
}

interface CanvasStore {
  canvases: Record<string, CanvasState | undefined>;
  /** "Show me this node": consumed by the canvas view, which pans and zooms to it. */
  focusRequest: { connectionId: string; nodeId: string } | null;
  /** Progress of adding tables (shared by all connections: only one add runs at a time in practice). */
  busy: boolean;
  error: string | null;

  addTables: (connectionId: string, tables: NewTable[]) => void;
  applyChanges: (connectionId: string, changes: NodeChange<TableFlowNode>[]) => void;
  toggleExpanded: (connectionId: string, nodeId: string) => void;
  selectAll: (connectionId: string) => void;
  selectOnly: (connectionId: string, nodeId: string) => void;
  removeSelected: (connectionId: string) => void;
  resetLayout: (connectionId: string) => void;
  requestFocus: (connectionId: string, nodeId: string) => void;
  clearFocus: () => void;
  setStatus: (status: { busy: boolean; error: string | null }) => void;
  dropConnection: (connectionId: string) => void;
}

const EMPTY: CanvasState = { nodes: [], layoutVersion: 0 };

/** Size of a node on screen: the measured size once drawn, otherwise our estimate. */
function rectOf(node: TableFlowNode): Rect {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width ?? NODE_WIDTH,
    height: node.measured?.height ?? estimateNodeHeight(node.data.columnCount, node.data.expanded),
  };
}

export const useCanvasStore = create<CanvasStore>((set) => {
  /** Update one connection's canvas immutably. */
  const update = (connectionId: string, change: (canvas: CanvasState) => CanvasState): void =>
    set((state) => ({
      canvases: {
        ...state.canvases,
        [connectionId]: change(state.canvases[connectionId] ?? EMPTY),
      },
    }));

  return {
    canvases: {},
    focusRequest: null,
    busy: false,
    error: null,

    addTables(connectionId, tables) {
      update(connectionId, (canvas) => {
        const present = new Set(canvas.nodes.map((n) => n.id));
        const fresh = tables.filter((t) => !present.has(nodeIdFor(t.ref)));
        if (fresh.length === 0) return canvas;

        // First tables on an empty canvas: lay them all out together as a grid.
        // Otherwise place each new one in the first free spot, so nothing moves.
        const positions = new Map<string, { x: number; y: number }>();
        if (canvas.nodes.length === 0) {
          const layout = gridLayout(
            fresh.map((t) => ({
              id: nodeIdFor(t.ref),
              height: estimateNodeHeight(t.columnCount, false),
            })),
          );
          layout.forEach((point, id) => positions.set(id, point));
        } else {
          const occupied = canvas.nodes.map(rectOf);
          for (const t of fresh) {
            const size = { width: NODE_WIDTH, height: estimateNodeHeight(t.columnCount, false) };
            const point = nextFreePosition(occupied, size);
            occupied.push({ ...point, ...size });
            positions.set(nodeIdFor(t.ref), point);
          }
        }

        const added: TableFlowNode[] = fresh.map((t) => ({
          id: nodeIdFor(t.ref),
          type: "table",
          position: positions.get(nodeIdFor(t.ref)) ?? { x: 0, y: 0 },
          data: {
            schema: t.ref.schema,
            name: t.ref.name,
            expanded: false,
            columnCount: t.columnCount,
          },
        }));
        return {
          nodes: [...canvas.nodes, ...added],
          // The first batch on an empty canvas should fill the screen.
          layoutVersion:
            canvas.nodes.length === 0 ? canvas.layoutVersion + 1 : canvas.layoutVersion,
        };
      });
    },

    applyChanges(connectionId, changes) {
      update(connectionId, (canvas) => ({
        ...canvas,
        nodes: applyNodeChanges(changes, canvas.nodes),
      }));
    },

    toggleExpanded(connectionId, nodeId) {
      update(connectionId, (canvas) => ({
        ...canvas,
        nodes: canvas.nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, expanded: !n.data.expanded } } : n,
        ),
      }));
    },

    selectAll(connectionId) {
      update(connectionId, (canvas) => ({
        ...canvas,
        nodes: canvas.nodes.map((n) => ({ ...n, selected: true })),
      }));
    },

    selectOnly(connectionId, nodeId) {
      update(connectionId, (canvas) => ({
        ...canvas,
        nodes: canvas.nodes.map((n) => ({ ...n, selected: n.id === nodeId })),
      }));
    },

    removeSelected(connectionId) {
      update(connectionId, (canvas) => ({
        ...canvas,
        nodes: canvas.nodes.filter((n) => !n.selected),
      }));
    },

    resetLayout(connectionId) {
      update(connectionId, (canvas) => {
        // Keep the current reading order (top to bottom, then left to right) so
        // "reset" tidies up rather than shuffles.
        const ordered = [...canvas.nodes].sort(
          (a, b) => a.position.y - b.position.y || a.position.x - b.position.x,
        );
        const layout = gridLayout(
          ordered.map((n) => ({
            id: n.id,
            height: estimateNodeHeight(n.data.columnCount, n.data.expanded),
          })),
        );
        return {
          nodes: canvas.nodes.map((n) => ({ ...n, position: layout.get(n.id) ?? n.position })),
          layoutVersion: canvas.layoutVersion + 1,
        };
      });
    },

    requestFocus(connectionId, nodeId) {
      set({ focusRequest: { connectionId, nodeId } });
    },

    clearFocus() {
      set({ focusRequest: null });
    },

    setStatus(status) {
      set(status);
    },

    dropConnection(connectionId) {
      set((state) => {
        const rest = { ...state.canvases };
        delete rest[connectionId];
        return { canvases: rest };
      });
    },
  };
});
