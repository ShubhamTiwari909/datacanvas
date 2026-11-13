/**
 * Exporting the canvas as a PNG or SVG image.
 *
 * The library (html-to-image) draws a DOM element into an image. We point it at
 * React Flow's "viewport" element (the layer that holds the nodes and edges,
 * NOT the toolbar or minimap) and override its transform so that exactly the
 * bounding box of the tables is visible, whatever the current pan and zoom.
 *
 * PRIVACY: an exported image lists table and column names. The export dialog
 * says so before anything is created, and nothing is ever uploaded: the file is
 * created in the browser and saved by the browser.
 */
import { toPng, toSvg } from "html-to-image";

export type ImageFormat = "png" | "svg";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Empty margin around the tables, in canvas units. */
export const EXPORT_PADDING = 40;
/** No exported side is longer than this many pixels (browsers refuse very large canvases). */
export const MAX_EXPORT_SIDE = 8000;

export interface ExportGeometry {
  /** Size of the drawing in canvas units. */
  width: number;
  height: number;
  /** Where the tables' bounding box starts inside the drawing. */
  translateX: number;
  translateY: number;
  /** Multiplier for the PNG so no side exceeds MAX_EXPORT_SIDE (1 unless the drawing is huge). */
  pixelRatio: number;
}

/** Work out the image size and the shift that brings the bounding box to its top-left corner. */
export function exportGeometry(
  bounds: Bounds,
  padding = EXPORT_PADDING,
  maxSide = MAX_EXPORT_SIDE,
): ExportGeometry {
  const width = Math.ceil(bounds.width + padding * 2);
  const height = Math.ceil(bounds.height + padding * 2);
  return {
    width,
    height,
    translateX: padding - bounds.x,
    translateY: padding - bounds.y,
    pixelRatio: Math.min(1, maxSide / Math.max(width, height)),
  };
}

/** A safe file name stem: letters, digits, dash and underscore only. */
export function exportFileStem(name: string): string {
  const stem = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return stem === "" ? "datacanvas" : stem;
}

/**
 * The page's own background color, so an image exported in dark mode is dark
 * (the table cards keep their theme colors, and light text on a white sheet
 * would look broken). Falls back to white when the color cannot be read or is
 * transparent.
 */
export function exportBackground(): string {
  if (typeof document === "undefined") return "#ffffff";
  const color = getComputedStyle(document.body).backgroundColor;
  return color === "" || color === "transparent" || color === "rgba(0, 0, 0, 0)"
    ? "#ffffff"
    : color;
}

/**
 * Render the tables inside `viewportElement` to an image and ask the browser to
 * save it. `bounds` is the bounding box of the tables in canvas coordinates.
 */
export async function exportCanvasImage(
  format: ImageFormat,
  viewportElement: HTMLElement,
  bounds: Bounds,
  fileStem: string,
): Promise<void> {
  const geometry = exportGeometry(bounds);
  const options = {
    width: geometry.width,
    height: geometry.height,
    backgroundColor: exportBackground(),
    pixelRatio: geometry.pixelRatio,
    // Draw the viewport layer as if panned and zoomed to fit the bounding box exactly.
    style: {
      width: `${geometry.width}px`,
      height: `${geometry.height}px`,
      transform: `translate(${geometry.translateX}px, ${geometry.translateY}px) scale(1)`,
    },
  };

  const dataUrl =
    format === "png"
      ? await toPng(viewportElement, options)
      : await toSvg(viewportElement, options);

  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = `${exportFileStem(fileStem)}.${format}`;
  document.body.append(link);
  link.click();
  link.remove();
}
