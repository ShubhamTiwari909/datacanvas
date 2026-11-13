/**
 * Placing nodes on the canvas.
 *
 * Plain geometry: no React, no canvas library. Everything takes sizes and
 * returns positions, so it can be unit tested exhaustively.
 */
import { NODE_GAP_X, NODE_GAP_Y, NODE_WIDTH } from "./constants.js";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Rect = Point & Size;

export interface LayoutItem {
  id: string;
  height: number;
}

/**
 * Arrange items in a roughly square grid, row by row.
 *
 * Columns = ceil(sqrt(n)), so 1 item is alone, 4 make 2x2, 9 make 3x3, 100
 * make 10x10. Each row is as tall as its tallest item, so tall tables never
 * overlap the row below. The first item is at (0, 0).
 *
 * Items keep their input order, which makes the result predictable.
 */
export function gridLayout(items: readonly LayoutItem[]): Map<string, Point> {
  const positions = new Map<string, Point>();
  const columns = Math.max(1, Math.ceil(Math.sqrt(items.length)));

  let y = 0;
  for (let start = 0; start < items.length; start += columns) {
    const row = items.slice(start, start + columns);
    row.forEach((item, index) => {
      positions.set(item.id, { x: index * (NODE_WIDTH + NODE_GAP_X), y });
    });
    y += Math.max(...row.map((item) => item.height)) + NODE_GAP_Y;
  }
  return positions;
}

/** True when the two rectangles overlap, keeping `gap` of free space between them. */
function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

/**
 * Find a free spot for ONE new node next to existing ones.
 *
 * Scans a grid of slots (left to right, top to bottom, `columns` per row) and
 * returns the first slot where the node, with its gaps, overlaps nothing. The
 * slot pitch is the node width plus gap horizontally, and the new node's own
 * height plus gap vertically; a slot is only used if it is genuinely empty, so
 * stacking many tall nodes still never collides.
 */
export function nextFreePosition(
  existing: readonly Rect[],
  size: Size,
  options: { columns?: number } = {},
): Point {
  const columns = options.columns ?? 5;
  const pitchX = NODE_WIDTH + NODE_GAP_X;
  const pitchY = size.height + NODE_GAP_Y;

  // Bounded search: with n existing nodes, at most n+1 slots can be taken.
  const maxSlots = (existing.length + 1) * 4;
  for (let slot = 0; slot < maxSlots; slot += 1) {
    const candidate: Rect = {
      x: (slot % columns) * pitchX,
      y: Math.floor(slot / columns) * pitchY,
      ...size,
    };
    if (!existing.some((rect) => overlaps(candidate, rect, NODE_GAP_X / 2))) {
      return { x: candidate.x, y: candidate.y };
    }
  }
  // Unreachable in practice; fall back to below everything.
  const bottom = Math.max(0, ...existing.map((rect) => rect.y + rect.height));
  return { x: 0, y: bottom + NODE_GAP_Y };
}
