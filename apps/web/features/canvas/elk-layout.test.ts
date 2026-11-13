import { describe, expect, it } from "vitest";
import { autoLayout, type LayoutEdge, type LayoutNode } from "./elk-layout";

const node = (id: string, height = 120): LayoutNode => ({ id, width: 280, height });
const edge = (source: string, target: string): LayoutEdge => ({
  id: `${source}>${target}`,
  source,
  target,
});

/** Do any two nodes overlap? Returns the first overlapping pair, or null. */
function overlapping(
  nodes: LayoutNode[],
  positions: Map<string, { x: number; y: number }>,
): [string, string] | null {
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i] as LayoutNode;
      const b = nodes[j] as LayoutNode;
      const pa = positions.get(a.id) as { x: number; y: number };
      const pb = positions.get(b.id) as { x: number; y: number };
      if (
        pa.x < pb.x + b.width &&
        pa.x + a.width > pb.x &&
        pa.y < pb.y + b.height &&
        pa.y + a.height > pb.y
      )
        return [a.id, b.id];
    }
  }
  return null;
}

// The shop: order_items -> orders -> users <- user_profiles, order_items -> products; an island: addresses -> regions; a loner.
const shopNodes = [
  "order_items",
  "orders",
  "users",
  "user_profiles",
  "products",
  "addresses",
  "regions",
  "audit_log",
].map((id) => node(id, 100 + (id.length % 5) * 30));
const shopEdges = [
  edge("order_items", "orders"),
  edge("order_items", "products"),
  edge("orders", "users"),
  edge("user_profiles", "users"),
  edge("addresses", "regions"),
];

describe("autoLayout (real ELK)", () => {
  for (const kind of ["hierarchical", "compact", "grouped"] as const) {
    describe(kind, () => {
      it("gives every node a position, anchored at the origin, without overlaps", async () => {
        const positions = await autoLayout(kind, shopNodes, shopEdges);

        expect(positions.size).toBe(shopNodes.length);
        expect(overlapping(shopNodes, positions)).toBeNull();
        const xs = [...positions.values()].map((p) => p.x);
        const ys = [...positions.values()].map((p) => p.y);
        expect(Math.min(...xs)).toBe(0);
        expect(Math.min(...ys)).toBe(0);
        for (const p of positions.values()) {
          expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        }
      });

      it("copes with no nodes, one node, and nodes without any edges", async () => {
        expect((await autoLayout(kind, [], [])).size).toBe(0);
        expect([...(await autoLayout(kind, [node("only")], [])).values()]).toEqual([
          { x: 0, y: 0 },
        ]);
        const loose = ["a", "b", "c", "d"].map((id) => node(id));
        expect(overlapping(loose, await autoLayout(kind, loose, []))).toBeNull();
      });

      it("ignores self-references and edges to tables that are not in the graph", async () => {
        const nodes = [node("a"), node("b")];
        const positions = await autoLayout(kind, nodes, [
          edge("a", "a"),
          edge("a", "ghost"),
          edge("a", "b"),
        ]);
        expect(positions.size).toBe(2);
        expect(overlapping(nodes, positions)).toBeNull();
      });
    });
  }

  it("hierarchical: puts a table to the LEFT of the tables it references (edges flow left to right)", async () => {
    const nodes = ["child", "parent", "grandparent"].map((id) => node(id));
    const positions = await autoLayout("hierarchical", nodes, [
      edge("child", "parent"),
      edge("parent", "grandparent"),
    ]);
    const x = (id: string) => (positions.get(id) as { x: number }).x;
    expect(x("child")).toBeLessThan(x("parent"));
    expect(x("parent")).toBeLessThan(x("grandparent"));
  });

  it("grouped: keeps each cluster together and apart from the others", async () => {
    const positions = await autoLayout("grouped", shopNodes, shopEdges);
    const box = (ids: string[]) => {
      const rects = ids.map((id) => {
        const n = shopNodes.find((s) => s.id === id) as LayoutNode;
        const p = positions.get(id) as { x: number; y: number };
        return { x1: p.x, y1: p.y, x2: p.x + n.width, y2: p.y + n.height };
      });
      return {
        x1: Math.min(...rects.map((r) => r.x1)),
        y1: Math.min(...rects.map((r) => r.y1)),
        x2: Math.max(...rects.map((r) => r.x2)),
        y2: Math.max(...rects.map((r) => r.y2)),
      };
    };
    const main = box(["order_items", "orders", "users", "user_profiles", "products"]);
    const island = box(["addresses", "regions"]);
    const separate =
      main.x2 <= island.x1 || island.x2 <= main.x1 || main.y2 <= island.y1 || island.y2 <= main.y1;
    expect(separate).toBe(true);
  });

  it("is deterministic", async () => {
    const a = await autoLayout("hierarchical", shopNodes, shopEdges);
    const b = await autoLayout("hierarchical", shopNodes, shopEdges);
    expect([...a]).toEqual([...b]);
  });

  it("lays out 120 tables with 136 relationships without overlaps, quickly enough", async () => {
    const nodes = Array.from({ length: 120 }, (_v, i) => node(`t${i}`, 100 + (i % 7) * 40));
    const edges = Array.from({ length: 119 }, (_v, i) =>
      edge(`t${i + 1}`, `t${Math.floor(i / 2)}`),
    );
    const started = performance.now();
    const positions = await autoLayout("hierarchical", nodes, edges);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(overlapping(nodes, positions)).toBeNull();
  }, 15000);
});
