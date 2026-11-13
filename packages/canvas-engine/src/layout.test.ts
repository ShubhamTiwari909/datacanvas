import { describe, expect, it } from "vitest";
import { NODE_GAP_X, NODE_GAP_Y, NODE_WIDTH } from "./constants.js";
import { gridLayout, nextFreePosition, type Rect } from "./layout.js";

const items = (heights: number[]) => heights.map((height, i) => ({ id: `n${i}`, height }));

/** Deterministic pseudo-random numbers, so a "random" test is reproducible. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe("gridLayout", () => {
  it("returns nothing for no items, and the origin for one", () => {
    expect(gridLayout([]).size).toBe(0);
    expect(gridLayout(items([100])).get("n0")).toEqual({ x: 0, y: 0 });
  });

  it("makes a square grid: 4 items are 2x2, 9 are 3x3", () => {
    const four = gridLayout(items([100, 100, 100, 100]));
    expect([...four.values()].map((p) => p.x)).toEqual([0, 360, 0, 360]);
    const nine = gridLayout(items(Array(9).fill(100)));
    expect(new Set([...nine.values()].map((p) => p.x)).size).toBe(3);
    expect(new Set([...nine.values()].map((p) => p.y)).size).toBe(3);
  });

  it("uses the pitch of node width plus gap", () => {
    const layout = gridLayout(items([100, 100]));
    expect(layout.get("n1")?.x).toBe(NODE_WIDTH + NODE_GAP_X);
  });

  it("makes each row as tall as its tallest item", () => {
    const layout = gridLayout(items([100, 500, 100, 100])); // two rows of two
    expect(layout.get("n2")?.y).toBe(500 + NODE_GAP_Y);
  });

  it("never overlaps nodes, whatever their heights", () => {
    const random = lcg(42);
    const list = Array.from({ length: 57 }, (_v, i) => ({
      id: `n${i}`,
      height: 70 + Math.floor(random() * 400),
    }));
    const layout = gridLayout(list);
    const rects: Rect[] = list.map((item) => ({
      ...(layout.get(item.id) as { x: number; y: number }),
      width: NODE_WIDTH,
      height: item.height,
    }));
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        expect(intersects(rects[i] as Rect, rects[j] as Rect), `${i} vs ${j}`).toBe(false);
      }
    }
  });

  it("keeps the input order", () => {
    const layout = gridLayout(items([10, 10, 10]));
    expect([...layout.keys()]).toEqual(["n0", "n1", "n2"]);
  });
});

describe("nextFreePosition", () => {
  const size = { width: NODE_WIDTH, height: 200 };

  it("starts at the origin on an empty canvas", () => {
    expect(nextFreePosition([], size)).toEqual({ x: 0, y: 0 });
  });

  it("skips occupied slots", () => {
    const first = nextFreePosition([], size);
    const second = nextFreePosition([{ ...first, ...size }], size);
    expect(second).toEqual({ x: NODE_WIDTH + NODE_GAP_X, y: 0 });
  });

  it("wraps to a new row after the configured number of columns", () => {
    const rects: Rect[] = [];
    for (let i = 0; i < 3; i += 1)
      rects.push({ ...nextFreePosition(rects, size, { columns: 3 }), ...size });
    const fourth = nextFreePosition(rects, size, { columns: 3 });
    expect(fourth).toEqual({ x: 0, y: 200 + NODE_GAP_Y });
  });

  it("fills a gap left by a removed node", () => {
    const a: Rect = { x: 0, y: 0, ...size };
    const c: Rect = { x: 2 * (NODE_WIDTH + NODE_GAP_X), y: 0, ...size }; // slot 1 is free
    expect(nextFreePosition([a, c], size)).toEqual({ x: NODE_WIDTH + NODE_GAP_X, y: 0 });
  });

  it("never collides, even with a mix of very different heights", () => {
    const random = lcg(7);
    const rects: Rect[] = [];
    for (let i = 0; i < 40; i += 1) {
      const nodeSize = { width: NODE_WIDTH, height: 70 + Math.floor(random() * 500) };
      const position = nextFreePosition(rects, nodeSize);
      const rect: Rect = { ...position, ...nodeSize };
      for (const other of rects) expect(intersects(rect, other), `node ${i}`).toBe(false);
      rects.push(rect);
    }
  });
});
