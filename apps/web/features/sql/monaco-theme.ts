/**
 * Monaco in the app's own colours. The app's colours are CSS variables in `oklch()`, which
 * Monaco cannot read, so each one is turned into a hex colour (through a canvas, which parses
 * any colour the browser knows) and the editor, its list of suggestions and its widgets are
 * painted with them. Called when the editor starts and whenever light or dark changes. If a
 * colour cannot be read the built-in `vs` / `vs-dark` theme is used as it is.
 */
import type { MonacoApi } from "./monaco-setup";

const THEME = "datacanvas";

/** A CSS colour as `#rrggbb` (or `#rrggbbaa`), or null if the browser cannot parse it. */
function toHex(css: string): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "#000000";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (r === undefined || g === undefined || b === undefined || a === undefined) return null;
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${a === 255 ? "" : hex(a)}`;
}

/** The value of a CSS variable on the page, as a hex colour. */
function variable(name: string): string | null {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value ? toHex(value) : null;
}

export function applyAppTheme(monaco: MonacoApi, dark: boolean): void {
  const read = (name: string) => variable(name) ?? undefined;
  const colors: Record<string, string> = {};
  const set = (key: string, value: string | undefined) => {
    if (value) colors[key] = value;
  };

  const background = read("--background");
  const foreground = read("--foreground");
  const muted = read("--muted");
  const mutedForeground = read("--muted-foreground");
  const border = read("--border");
  const popover = read("--popover");
  const popoverForeground = read("--popover-foreground");
  const accent = read("--accent");
  const ring = read("--ring");

  set("editor.background", background);
  set("editor.foreground", foreground);
  set("editorGutter.background", background);
  set("editorLineNumber.foreground", mutedForeground);
  set("editorLineNumber.activeForeground", foreground);
  set("editor.lineHighlightBackground", muted);
  set("editor.lineHighlightBorder", "#00000000");
  set("editorCursor.foreground", foreground);
  set("editorWidget.background", popover);
  set("editorWidget.foreground", popoverForeground);
  set("editorWidget.border", border);
  set("editorSuggestWidget.background", popover);
  set("editorSuggestWidget.foreground", popoverForeground);
  set("editorSuggestWidget.border", border);
  set("editorSuggestWidget.selectedBackground", accent);
  set("editorHoverWidget.background", popover);
  set("editorHoverWidget.foreground", popoverForeground);
  set("editorHoverWidget.border", border);
  set("focusBorder", ring);
  set("scrollbarSlider.background", border);
  set("input.background", background);

  monaco.editor.defineTheme(THEME, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors,
  });
  monaco.editor.setTheme(THEME);
}
