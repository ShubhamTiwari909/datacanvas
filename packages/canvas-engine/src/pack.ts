/**
 * Packing rectangles (groups of tables) neatly onto the canvas.
 */
import type { Point, Size } from "./layout.js";

export interface PackItem extends Size {
  id: string;
}

/**
 * "Shelf" packing: place items left to right, and start a new shelf (row) when
 * the next item would pass `maxWidth`. Each shelf is as tall as its tallest
 * item. Simple, predictable and overlap-free; not the tightest possible packing.
 *
 * Returns the position of each item and the overall size.
 */
export function shelfPack(
  items: readonly PackItem[],
  options: { maxWidth: number; gap: number },
): { positions: Map<string, Point>; width: number; height: number } {
  const positions = new Map<string, Point>();
  let x = 0;
  let y = 0;
  let shelfHeight = 0;
  let usedWidth = 0;

  for (const item of items) {
    // Wrap only if something is already on this shelf: an item wider than maxWidth still gets placed.
    if (x > 0 && x + item.width > options.maxWidth) {
      x = 0;
      y += shelfHeight + options.gap;
      shelfHeight = 0;
    }
    positions.set(item.id, { x, y });
    x += item.width + options.gap;
    shelfHeight = Math.max(shelfHeight, item.height);
    usedWidth = Math.max(usedWidth, x - options.gap);
  }
  return { positions, width: usedWidth, height: items.length === 0 ? 0 : y + shelfHeight };
}
