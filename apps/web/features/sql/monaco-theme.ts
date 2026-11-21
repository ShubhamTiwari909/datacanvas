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
  // A transparent start: a colour the browser cannot parse leaves it as it is, and is seen as not read.
  ctx.fillStyle = "rgba(0, 0, 0, 0)";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (r === undefined || g === undefined || b === undefined || a === undefined || a === 0)
    return null;
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${a === 255 ? "" : hex(a)}`;
}

/** The value of a CSS variable on the page, as a hex colour. */
function variable(name: string): string | null {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value ? toHex(value) : null;
}

/**
 * Colours for the tokens of the JSON editor (`features/json/json-language.ts`). Monaco's own palettes
 * are not accessible on the app's backgrounds (axe found text under 4.5:1), so each colour here is
 * chosen to be at least 4.5:1 on the page background of its theme.
 */
const JSON_TOKEN_COLORS = {
  light: {
    "string.key.json": "0b4f8a",
    "string.value.json": "a31515",
    "number.json": "0b6b37",
    "keyword.json": "6b21a8",
    "string.invalid": "b00020",
    invalid: "b00020",
  },
  dark: {
    "string.key.json": "7cc4ff",
    "string.value.json": "f0a38a",
    "number.json": "b5e0a0",
    "keyword.json": "d0a8ff",
    "string.invalid": "ff8a8a",
    invalid: "ff8a8a",
  },
} as const;

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
    rules: Object.entries(JSON_TOKEN_COLORS[dark ? "dark" : "light"]).map(
      ([token, foreground]) => ({
        token,
        foreground,
      }),
    ),
    colors,
  });
  monaco.editor.setTheme(THEME);
}
