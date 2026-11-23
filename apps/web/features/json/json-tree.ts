/**
 * The tree view of a JSON document (`docs/advanced-data-workspace-plan.md`, section 5): objects and
 * arrays that open and close, long strings cut, and the path of any node as text.
 *
 * Built from the tokens `checkJson` already accepted, so every number and string is shown as it is
 * written (a number is never turned into a double).
 */
import { checkJson, type JsonToken } from "./json-text";

export type TreeKind = "object" | "array" | "string" | "number" | "literal";

export interface TreeNode {
  /** The key in its parent (a string), or the index (a number); null for the root. */
  step: string | number | null;
  kind: TreeKind;
  /** What is shown for a value: the text as written, cut if long; for a container, "{3 keys}" or "[2 items]". */
  preview: string;
  /** True when a string was cut for display. */
  cut: boolean;
  /** The whole text of a string, number or literal as written (strings with their quotes). */
  text: string | null;
  children: TreeNode[];
}

/** The most characters of a string value shown in the tree. */
export const TREE_STRING_CHARS = 80;
/** The most nodes built: a document with more is shown as far as this and says so. */
export const TREE_MAX_NODES = 5000;

export interface JsonTree {
  root: TreeNode;
  /** True when the document has more nodes than `TREE_MAX_NODES`. */
  truncated: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A string token (with its quotes) as the text it holds, or null if it cannot be read. */
function decode(token: string): string | null {
  try {
    const value: unknown = JSON.parse(token);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** The tree of a document, or null when it is not valid JSON. */
export function buildJsonTree(text: string): JsonTree | null {
  const checked = checkJson(text);
  if (!checked.ok) return null;
  const tokens = checked.tokens;
  let at = 0;
  let nodes = 0;
  let truncated = false;

  const value = (step: string | number | null): TreeNode => {
    nodes += 1;
    if (nodes > TREE_MAX_NODES) truncated = true;
    const t: JsonToken = tokens[at]!;
    at += 1;
    if (t.kind === "string") {
      // The token as written, escapes and all: a decoded \u202E would be a raw control character on screen.
      const cut = t.text.length > TREE_STRING_CHARS + 2;
      return {
        step,
        kind: "string",
        preview: cut ? `${t.text.slice(0, TREE_STRING_CHARS + 1)}"…` : t.text,
        cut,
        text: t.text,
        children: [],
      };
    }
    if (t.kind !== "punct") {
      return { step, kind: t.kind, preview: t.text, cut: false, text: t.text, children: [] };
    }
    const isObject = t.text === "{";
    const close = isObject ? "}" : "]";
    const children: TreeNode[] = [];
    let seen = 0;
    if (tokens[at]?.text === close) {
      at += 1;
    } else {
      for (;;) {
        if (isObject) {
          const key = tokens[at]!;
          at += 1; // the key
          at += 1; // the colon
          const name = decode(key.text) ?? key.text;
          const child = value(name);
          seen += 1;
          // Past the limit the nodes are still walked (to find the end) but not kept.
          if (nodes <= TREE_MAX_NODES) children.push(child);
        } else {
          const child = value(seen);
          seen += 1;
          if (nodes <= TREE_MAX_NODES) children.push(child);
        }
        const next = tokens[at]!;
        at += 1;
        if (next.text === close) break;
      }
    }
    const count = isObject ? plural(seen, "key", "keys") : plural(seen, "item", "items");
    return {
      step,
      kind: isObject ? "object" : "array",
      preview: isObject ? `{${count}}` : `[${count}]`,
      cut: false,
      text: null,
      children,
    };
  };

  const root = value(null);
  return { root, truncated };
}

/** A key that can follow a dot as it is; anything else is written in quotes. */
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The path of a node as text, such as `$.a[0]."weird key"`. */
export function pathText(steps: ReadonlyArray<string | number>): string {
  let out = "$";
  for (const step of steps) {
    if (typeof step === "number") out += `[${step}]`;
    else out += PLAIN_KEY.test(step) ? `.${step}` : `.${JSON.stringify(step)}`;
  }
  return out;
}

/** The steps of a path in the form `json_path_eq` and `#>>` take: every step as text. */
export function pathSteps(steps: ReadonlyArray<string | number>): string[] {
  return steps.map(String);
}
