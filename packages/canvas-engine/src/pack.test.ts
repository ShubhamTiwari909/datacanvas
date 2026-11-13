import { describe, expect, it } from "vitest";
import { shelfPack } from "./pack.js";

const item = (id: string, width: number, height: number) => ({ id, width, height });

describe("shelfPack", () => {
  it("packs nothing into nothing", () => {
    expect(shelfPack([], { maxWidth: 1000, gap: 10 })).toMatchObject({ width: 0, height: 0 });
  });

  it("places items left to right on the first shelf", () => {
    const { positions } = shelfPack([item("a", 100, 50), item("b", 100, 80)], {
      maxWidth: 1000,
      gap: 10,
    });
    expect(positions.get("a")).toEqual({ x: 0, y: 0 });
    expect(positions.get("b")).toEqual({ x: 110, y: 0 });
  });

  it("wraps to a new shelf below the tallest item of the previous one", () => {
    const { positions, width, height } = shelfPack(
      [item("a", 100, 50), item("b", 100, 80), item("c", 100, 20)],
      {
        maxWidth: 250,
        gap: 10,
      },
    );
    expect(positions.get("c")).toEqual({ x: 0, y: 90 }); // 80 (tallest on shelf 1) + gap
    expect(width).toBe(210);
    expect(height).toBe(110);
  });

  it("still places an item wider than the maximum", () => {
    const { positions } = shelfPack([item("wide", 500, 10), item("next", 50, 10)], {
      maxWidth: 100,
      gap: 5,
    });
    expect(positions.get("wide")).toEqual({ x: 0, y: 0 });
    expect(positions.get("next")).toEqual({ x: 0, y: 15 });
  });

  it("never overlaps, with mixed sizes", () => {
    const items = Array.from({ length: 40 }, (_v, i) =>
      item(`i${i}`, 50 + ((i * 37) % 200), 30 + ((i * 53) % 300)),
    );
    const { positions } = shelfPack(items, { maxWidth: 800, gap: 12 });
    const rects = items.map((it) => ({
      ...(positions.get(it.id) as { x: number; y: number }),
      width: it.width,
      height: it.height,
    }));
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlap =
          a.x < b.x + b.width &&
          a.x + a.width > b.x &&
          a.y < b.y + b.height &&
          a.y + a.height > b.y;
        expect(overlap, `${i} vs ${j}`).toBe(false);
      }
    }
  });
});
