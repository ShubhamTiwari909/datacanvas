/**
 * Graph algorithms over tables and their foreign keys.
 *
 * The database is a GRAPH: tables are nodes, foreign keys are edges. These
 * pure functions answer the questions the canvas asks:
 *   - which tables are within N hops of this one?       (reachableWithin)
 *   - how are these two tables connected?               (shortestPath)
 *   - which tables form separate clusters?              (connectedComponents)
 *
 * All of them use BREADTH-FIRST search (BFS): explore every neighbour at
 * distance 1, then every neighbour at distance 2, and so on, using a queue.
 * BFS is the right tool because it finds nodes in order of distance, so "within
 * N hops" is simply "stop after N levels", and the first time it reaches a node
 * is by a shortest route.
 *
 * Edges have a DIRECTION: from the table that holds the foreign key (source) to
 * the table it references (target). Callers choose which way to walk.
 */
import type { RelationshipInfo } from "@datacanvas/database-core";
import { nodeIdFor } from "./ids.js";

export interface GraphEdge {
  source: string;
  target: string;
}

/**
 * Which way to follow edges.
 *   "outgoing": from a table to the tables it REFERENCES (its parents), e.g. order_items -> orders;
 *   "incoming": from a table to the tables that REFERENCE it (its children), e.g. orders -> order_items;
 *   "both":     ignore direction.
 */
export type Direction = "both" | "outgoing" | "incoming";

/** One graph edge per foreign key, between node ids. */
export function relationshipEdges(relationships: readonly RelationshipInfo[]): GraphEdge[] {
  return relationships.map((r) => ({
    source: nodeIdFor({ schema: r.source.schema, name: r.source.table }),
    target: nodeIdFor({ schema: r.target.schema, name: r.target.table }),
  }));
}

/** node id -> ids of its neighbours in the chosen direction. Self-references are ignored: a table is not its own neighbour. */
function neighbourLists(edges: readonly GraphEdge[], direction: Direction): Map<string, string[]> {
  const lists = new Map<string, string[]>();
  const add = (from: string, to: string): void => {
    const list = lists.get(from);
    if (list) list.push(to);
    else lists.set(from, [to]);
  };
  for (const { source, target } of edges) {
    if (source === target) continue;
    if (direction !== "incoming") add(source, target);
    if (direction !== "outgoing") add(target, source);
  }
  return lists;
}

/**
 * Every node within `maxHops` edges of any start node, with its distance.
 *
 * Start nodes are included at distance 0, even if they have no edges at all.
 * `maxHops` of 0 returns only the start nodes.
 *
 * Cost: each node is visited once and each edge looked at a constant number
 * of times, so O(nodes + edges): fast even for thousands of tables.
 */
export function reachableWithin(
  starts: Iterable<string>,
  edges: readonly GraphEdge[],
  maxHops: number,
  direction: Direction = "both",
): Map<string, number> {
  const neighbours = neighbourLists(edges, direction);
  const distance = new Map<string, number>();
  let level: string[] = [];
  for (const start of starts) {
    if (!distance.has(start)) {
      distance.set(start, 0);
      level.push(start);
    }
  }

  // Process one level (all nodes at the same distance) at a time.
  for (let hops = 1; hops <= maxHops && level.length > 0; hops += 1) {
    const next: string[] = [];
    for (const node of level) {
      for (const neighbour of neighbours.get(node) ?? []) {
        if (distance.has(neighbour)) continue; // already reached by a route at least as short
        distance.set(neighbour, hops);
        next.push(neighbour);
      }
    }
    level = next;
  }
  return distance;
}

/**
 * The shortest chain of tables from `from` to `to` (both included), or null if
 * they are not connected. Walks BFS and remembers, for each node, which node it
 * was reached from, then follows those links back from the target.
 */
export function shortestPath(
  from: string,
  to: string,
  edges: readonly GraphEdge[],
  direction: Direction = "both",
): string[] | null {
  if (from === to) return [from];
  const neighbours = neighbourLists(edges, direction);
  const cameFrom = new Map<string, string>();
  const queue: string[] = [from];
  const seen = new Set<string>([from]);

  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head] as string;
    for (const neighbour of neighbours.get(node) ?? []) {
      if (seen.has(neighbour)) continue;
      seen.add(neighbour);
      cameFrom.set(neighbour, node);
      if (neighbour === to) {
        const path = [to];
        for (let step = to; step !== from;) {
          step = cameFrom.get(step) as string;
          path.push(step);
        }
        return path.reverse();
      }
      queue.push(neighbour);
    }
  }
  return null;
}

/**
 * Split nodes into groups of tables that are connected to each other (ignoring
 * direction). Isolated tables form groups of one. Groups and the nodes inside
 * them keep the order of `nodeIds`.
 */
export function connectedComponents(
  nodeIds: readonly string[],
  edges: readonly GraphEdge[],
): string[][] {
  const known = new Set(nodeIds);
  // Only edges between the given nodes count.
  const inside = edges.filter((e) => known.has(e.source) && known.has(e.target));
  const position = new Map(nodeIds.map((id, index) => [id, index]));
  const assigned = new Set<string>();
  const components: string[][] = [];

  for (const id of nodeIds) {
    if (assigned.has(id)) continue;
    // Everything reachable from `id`, at any distance, ignoring direction, is one component.
    const members = [...reachableWithin([id], inside, Infinity, "both").keys()];
    members.sort((a, b) => (position.get(a) as number) - (position.get(b) as number));
    members.forEach((member) => assigned.add(member));
    components.push(members);
  }
  return components;
}
