import { describe, expect, it } from "vitest";
import { EXPORT_PADDING, MAX_EXPORT_SIDE, exportFileStem, exportGeometry } from "./export-image";

describe("exportGeometry", () => {
  it("adds padding on every side and shifts the bounding box to it", () => {
    const g = exportGeometry({ x: 100, y: -50, width: 600, height: 400 });
    expect(g).toEqual({
      width: 600 + 2 * EXPORT_PADDING,
      height: 400 + 2 * EXPORT_PADDING,
      translateX: EXPORT_PADDING - 100,
      translateY: EXPORT_PADDING + 50,
      pixelRatio: 1,
    });
  });

  it("rounds the size up to whole pixels", () => {
    expect(exportGeometry({ x: 0, y: 0, width: 100.2, height: 50.7 }).width).toBe(181);
  });

  it("scales a huge drawing down so no side passes the limit, keeping the aspect ratio", () => {
    const g = exportGeometry({ x: 0, y: 0, width: 24_000, height: 12_000 });
    expect(g.pixelRatio).toBeLessThan(1);
    expect(g.width * g.pixelRatio).toBeLessThanOrEqual(MAX_EXPORT_SIDE + 1);
    expect(g.height * g.pixelRatio).toBeLessThanOrEqual(MAX_EXPORT_SIDE);
  });

  it("never scales UP a small drawing", () => {
    expect(exportGeometry({ x: 0, y: 0, width: 10, height: 10 }).pixelRatio).toBe(1);
  });
});

describe("exportFileStem", () => {
  it.each([
    ["Orders overview", "Orders-overview"],
    ["../../etc/passwd", "etc-passwd"],
    ['a"b\r\nc', "a-b-c"],
    ["日本語", "datacanvas"],
    ["   ", "datacanvas"],
    ["x".repeat(100), "x".repeat(60)],
  ])("turns %j into a safe name", (input, expected) => {
    expect(exportFileStem(input)).toBe(expected);
  });
});
