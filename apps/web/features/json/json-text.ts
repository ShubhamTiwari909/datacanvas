/**
 * JSON as TEXT, for the JSON editor (`docs/advanced-data-workspace-plan.md`, section 5).
 *
 * Why not `JSON.parse` and `JSON.stringify`: they turn every number into a double, so
 * `12345678901234567890` becomes `12345678901234567000` when a document is "formatted", and the
 * error messages differ between browsers. A `jsonb` document with a large number or a precise
 * decimal must come out of Format with the same digits. So the text is tokenized (strictly, as RFC
 * 8259 says), checked by a small parser that reports the first error with its line and column, and
 * formatted or minified by re-writing the SAME tokens with other white space.
 */

export type JsonToken =
  | { kind: "punct"; text: "{" | "}" | "[" | "]" | ":" | ","; start: number; end: number }
  | { kind: "string" | "number" | "literal"; text: string; start: number; end: number };

export interface JsonError {
  message: string;
  /** 0-based position in the text. */
  offset: number;
  /** 1-based, counting `\n`, `\r` and `\r\n` as one line break each. */
  line: number;
  column: number;
}

export type JsonCheck = { ok: true; tokens: JsonToken[] } | { ok: false; error: JsonError };

const WHITESPACE = /[ \t\n\r]/;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** The deepest nesting accepted: a document that deep is not for a person to edit, and recursion has a limit. */
export const MAX_JSON_DEPTH = 200;

function locate(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    const c = text[i];
    if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) {
      line += 1;
      column = 1;
    } else if (c !== "\r") {
      column += 1;
    }
  }
  return { line, column };
}

const fail = (text: string, offset: number, message: string): JsonCheck => ({
  ok: false,
  error: { message, offset, ...locate(text, offset) },
});

/** Split the text into tokens, or say where it stops being JSON. */
function tokenize(text: string): { tokens: JsonToken[] } | { error: JsonCheck & { ok: false } } {
  const tokens: JsonToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (WHITESPACE.test(c)) {
      i += 1;
      continue;
    }
    if ("{}[]:,".includes(c)) {
      tokens.push({ kind: "punct", text: c as "{", start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) {
          return {
            error: fail(text, i, "This string is not closed.") as JsonCheck & { ok: false },
          };
        }
        const d = text[j]!;
        if (d === '"') break;
        if (d < " ") {
          return {
            error: fail(
              text,
              j,
              "A line break or control character must be written as an escape (\\n) inside a string.",
            ) as JsonCheck & { ok: false },
          };
        }
        if (d === "\\") {
          const e = text[j + 1];
          if (e === "u") {
            if (!/^[0-9a-fA-F]{4}$/.test(text.slice(j + 2, j + 6))) {
              return {
                error: fail(
                  text,
                  j,
                  "An escape \\u needs four hexadecimal digits.",
                ) as JsonCheck & { ok: false },
              };
            }
            const unit = parseInt(text.slice(j + 2, j + 6), 16);
            if (unit === 0) {
              return {
                error: fail(
                  text,
                  j,
                  "PostgreSQL does not accept \\u0000 in a JSON value.",
                ) as JsonCheck & { ok: false },
              };
            }
            if (unit >= 0xd800 && unit <= 0xdbff) {
              // A high surrogate must be followed by the escape of a low one.
              const low = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(text.slice(j + 6, j + 12));
              if (!low) {
                return {
                  error: fail(
                    text,
                    j,
                    "This escape is half of a character: it needs a second \\u escape after it.",
                  ) as JsonCheck & { ok: false },
                };
              }
              j += 6;
            } else if (unit >= 0xdc00 && unit <= 0xdfff) {
              return {
                error: fail(
                  text,
                  j,
                  "This escape is half of a character: it must follow another \\u escape.",
                ) as JsonCheck & { ok: false },
              };
            }
            j += 6;
            continue;
          }
          if (e === undefined || !'"\\/bfnrt'.includes(e)) {
            return {
              error: fail(text, j, "This is not a valid escape.") as JsonCheck & { ok: false },
            };
          }
          j += 2;
          continue;
        }
        j += 1;
      }
      tokens.push({ kind: "string", text: text.slice(i, j + 1), start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m)
        return { error: fail(text, i, "This is not a valid number.") as JsonCheck & { ok: false } };
      const end = i + m[0].length;
      // 01, 1.e3 and the like must not be read as a number followed by something else.
      if (/[0-9A-Za-z.+-]/.test(text[end] ?? "")) {
        return { error: fail(text, i, "This is not a valid number.") as JsonCheck & { ok: false } };
      }
      tokens.push({ kind: "number", text: m[0], start: i, end });
      i = end;
      continue;
    }
    const word = /^(true|false|null)(?![A-Za-z0-9_])/.exec(text.slice(i, i + 6));
    if (word) {
      tokens.push({ kind: "literal", text: word[1]!, start: i, end: i + word[1]!.length });
      i += word[1]!.length;
      continue;
    }
    return {
      error: fail(
        text,
        i,
        `Unexpected "${c}". JSON has no comments, single quotes or bare words.`,
      ) as JsonCheck & { ok: false },
    };
  }
  return { tokens };
}

/** What a token is, in words: never the text of a value, which can be long or secret. */
function describeToken(t: JsonToken): string {
  if (t.kind === "punct") return `"${t.text}"`;
  if (t.kind === "string") return "a string";
  if (t.kind === "number") return "a number";
  return "a word";
}

/** Check a document: one value, nothing after it. The first problem is returned with its place. */
export function checkJson(text: string): JsonCheck {
  const lexed = tokenize(text);
  if ("error" in lexed) return lexed.error;
  const { tokens } = lexed;
  if (tokens.length === 0) return fail(text, text.length, "This is empty. JSON needs a value.");
  let at = 0;
  const here = (): JsonToken | undefined => tokens[at];
  const unexpected = (what: string): JsonCheck => {
    const t = here();
    return fail(
      text,
      t ? t.start : text.length,
      t
        ? `Expected ${what}, found ${describeToken(t)}.`
        : `The text ends where ${what} was expected.`,
    );
  };

  const value = (depth: number): JsonCheck | null => {
    if (depth > MAX_JSON_DEPTH)
      return fail(
        text,
        here()?.start ?? 0,
        `This is nested more than ${MAX_JSON_DEPTH} levels deep.`,
      );
    const t = here();
    if (!t) return unexpected("a value");
    if (t.kind !== "punct") {
      at += 1;
      return null;
    }
    if (t.text === "{") {
      at += 1;
      if (here()?.text === "}") {
        at += 1;
        return null;
      }
      for (;;) {
        const key = here();
        if (!key || key.kind !== "string") return unexpected("a key in double quotes");
        at += 1;
        if (here()?.text !== ":") return unexpected('":"');
        at += 1;
        const inner = value(depth + 1);
        if (inner) return inner;
        const next = here();
        if (next?.text === ",") {
          at += 1;
          continue;
        }
        if (next?.text === "}") {
          at += 1;
          return null;
        }
        return unexpected('"," or "}"');
      }
    }
    if (t.text === "[") {
      at += 1;
      if (here()?.text === "]") {
        at += 1;
        return null;
      }
      for (;;) {
        const inner = value(depth + 1);
        if (inner) return inner;
        const next = here();
        if (next?.text === ",") {
          at += 1;
          continue;
        }
        if (next?.text === "]") {
          at += 1;
          return null;
        }
        return unexpected('"," or "]"');
      }
    }
    return unexpected("a value");
  };

  const problem = value(0);
  if (problem) return problem;
  if (at < tokens.length) return unexpected("the end of the document");
  return { ok: true, tokens };
}

/** The same tokens with other white space. `indent` is the spaces per level, or 0 for one line. */
export function layoutJson(tokens: readonly JsonToken[], indent: number): string {
  const pad = (n: number) => (indent > 0 ? `\n${" ".repeat(indent * n)}` : "");
  let out = "";
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1];
    if (t.kind !== "punct") {
      out += t.text;
      continue;
    }
    switch (t.text) {
      case "{":
      case "[":
        out += t.text;
        if (next && (next.text === "}" || next.text === "]") && next.kind === "punct") {
          out += next.text;
          i += 1;
        } else {
          depth += 1;
          out += pad(depth);
        }
        break;
      case "}":
      case "]":
        depth -= 1;
        out += pad(depth) + t.text;
        break;
      case ",":
        out += "," + pad(depth);
        break;
      case ":":
        out += indent > 0 ? ": " : ":";
        break;
    }
  }
  return out;
}

/** Format (2 spaces) or minify a document, keeping every string and number exactly as written. Null when it is not valid. */
export function formatJson(text: string, indent = 2): string | null {
  const checked = checkJson(text);
  return checked.ok ? layoutJson(checked.tokens, indent) : null;
}
