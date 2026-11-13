/**
 * Automatic layouts, computed by ELK (the Eclipse Layout Kernel, a mature graph
 * layout library). ELK is large, so it is loaded only when a layout is first
 * requested (a dynamic import becomes a separate chunk).
 *
 * ELK itself knows nothing about tables: this file converts our nodes and edges
 * into ELK's graph format, runs it, and converts the positions back.
 *
 *   hierarchical  layered layout: relationships flow left to right, so tables a
 *                 table depends on sit to its right, and edges cross as little as possible
 *   compact       rectangle packing: ignores relationships, fits tables into the smallest
 *                 roughly 16:10 block
 *   grouped       each cluster of connected tables is laid out separately
 *                 (layered), then the clusters are packed, so related tables
 *                 stay together and unrelated groups do not interleave
 */
import {
  connectedComponents,
  shelfPack,
  NODE_GAP_X,
  NODE_GAP_Y,
  type Point,
} from "@datacanvas/canvas-engine";

export type AutoLayoutKind = "hierarchical" | "compact" | "grouped";

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
}

interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  children?: ElkNode[];
  edges?: Array<{ id: string; sources: string[]; targets: string[] }>;
  layoutOptions?: Record<string, string>;
}

type ElkInstance = { layout: (graph: ElkNode) => Promise<ElkNode> };

let elkPromise: Promise<ElkInstance> | undefined;

/** Load ELK once and reuse it. */
function loadElk(): Promise<ElkInstance> {
  elkPromise ??= import("elkjs/lib/elk.bundled.js").then((module) => {
    const ELK = module.default;
    return new ELK() as unknown as ElkInstance;
  });
  return elkPromise;
}

const LAYERED: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "140",
  "elk.spacing.nodeNode": "50",
  "elk.spacing.componentComponent": "90",
};

const COMPACT: Record<string, string> = {
  "elk.algorithm": "rectpacking",
  "elk.spacing.nodeNode": String(Math.min(NODE_GAP_X, NODE_GAP_Y)),
  "elk.aspectRatio": "1.6",
};

async function runElk(
  options: Record<string, string>,
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Promise<Map<string, Point>> {
  const known = new Set(nodes.map((n) => n.id));
  const elk = await loadElk();
  const result = await elk.layout({
    id: "root",
    layoutOptions: options,
    children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    // Only edges between nodes in this graph; self-references add nothing to a layout.
    edges: edges
      .filter((e) => e.source !== e.target && known.has(e.source) && known.has(e.target))
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  const positions = new Map<string, Point>();
  for (const child of result.children ?? [])
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  return positions;
}

/** Positions for every node, with the top-left of the whole drawing at (0, 0). */
export async function autoLayout(
  kind: AutoLayoutKind,
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Promise<Map<string, Point>> {
  if (nodes.length === 0) return new Map();

  if (kind === "hierarchical") return normalise(await runElk(LAYERED, nodes, edges), nodes);
  if (kind === "compact") return normalise(await runElk(COMPACT, nodes, edges), nodes);

  // grouped: one layered layout per connected cluster, then pack the clusters.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const clusters = connectedComponents(
    nodes.map((n) => n.id),
    edges,
  );
  const laidOut = await Promise.all(
    clusters.map(async (ids) => {
      const members = ids.map((id) => byId.get(id) as LayoutNode);
      const local = normalise(await runElk(LAYERED, members, edges), members);
      const width = Math.max(...members.map((m) => (local.get(m.id) as Point).x + m.width));
      const height = Math.max(...members.map((m) => (local.get(m.id) as Point).y + m.height));
      return { ids, local, width, height };
    }),
  );

  // Biggest clusters first, so the large connected structure sits top left.
  const ordered = laidOut
    .map((c, index) => ({ ...c, id: String(index) }))
    .sort((a, b) => b.ids.length - a.ids.length);
  const totalArea = ordered.reduce((sum, c) => sum + c.width * c.height, 0);
  const packed = shelfPack(ordered, {
    maxWidth: Math.max(Math.sqrt(totalArea * 1.6), ...ordered.map((c) => c.width)),
    gap: 120,
  });

  const positions = new Map<string, Point>();
  for (const cluster of ordered) {
    const origin = packed.positions.get(cluster.id) as Point;
    for (const id of cluster.ids) {
      const local = cluster.local.get(id) as Point;
      positions.set(id, { x: origin.x + local.x, y: origin.y + local.y });
    }
  }
  return positions;
}

/** Shift positions so the top-left corner of the drawing is (0, 0), and round to whole units. */
function normalise(
  positions: Map<string, Point>,
  nodes: readonly LayoutNode[],
): Map<string, Point> {
  const xs = nodes.map((n) => positions.get(n.id)?.x ?? 0);
  const ys = nodes.map((n) => positions.get(n.id)?.y ?? 0);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return new Map(
    nodes.map((n) => {
      const p = positions.get(n.id) ?? { x: 0, y: 0 };
      return [n.id, { x: Math.round(p.x - minX), y: Math.round(p.y - minY) }];
    }),
  );
}
