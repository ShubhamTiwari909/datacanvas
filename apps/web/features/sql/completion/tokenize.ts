/**
 * A small SQL tokenizer for completion: it knows where words, quoted names, strings, comments
 * and punctuation are, which is all that suggesting a name needs. It is NOT a parser and never
 * runs or checks the text; an unfinished string, quoted name or comment runs to the end and is
 * marked `open`, because that is the state of the text while someone is typing it.
 */
export type TokenType = "word" | "quoted" | "string" | "number" | "punct" | "comment";

export interface Token {
  type: TokenType;
  text: string;
  /** Offset of the first character, and of the one after the last. */
  start: number;
  end: number;
  /** A string, quoted name or block comment that was never closed. */
  open: boolean;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  const push = (type: TokenType, start: number, end: number, open = false) =>
    tokens.push({ type, text: text.slice(start, end), start, end, open });

  while (i < n) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && text[i + 1] === "-") {
      const start = i;
      while (i < n && text[i] !== "\n") i++;
      push("comment", start, i);
    } else if (c === "/" && text[i + 1] === "*") {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (text.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      push("comment", start, i, depth > 0);
    } else if (c === "'") {
      const start = i;
      // E'...' (an escape string) reads a backslash as an escape; '...' does not.
      const escapes =
        (text[start - 1] === "E" || text[start - 1] === "e") &&
        (start < 2 || !WORD_PART.test(text[start - 2]!));
      i++;
      let closed = false;
      while (i < n) {
        if (escapes && text[i] === "\\") i += 2;
        else if (text[i] === "'" && text[i + 1] === "'") i += 2;
        else if (text[i] === "'") {
          i++;
          closed = true;
          break;
        } else i++;
      }
      push("string", start, i, !closed);
    } else if (c === '"') {
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (text[i] === '"' && text[i + 1] === '"') i += 2;
        else if (text[i] === '"') {
          i++;
          closed = true;
          break;
        } else i++;
      }
      push("quoted", start, i, !closed);
    } else if (c === "$" && DOLLAR_TAG.test(text.slice(i, i + 100))) {
      // A dollar-quoted string: $$ ... $$ or $tag$ ... $tag$ (a tag is a name: letters, digits after the first, underscores).
      const start = i;
      const tag = DOLLAR_TAG.exec(text.slice(i, i + 100))![0];
      const close = text.indexOf(tag, i + tag.length);
      i = close < 0 ? n : close + tag.length;
      push("string", start, i, close < 0);
    } else if (WORD_START.test(c)) {
      const start = i;
      i++;
      while (i < n && WORD_PART.test(text[i]!)) i++;
      push("word", start, i);
    } else if (/[0-9]/.test(c)) {
      const start = i;
      while (i < n && /[0-9.eE_]/.test(text[i]!)) i++;
      push("number", start, i);
    } else {
      push("punct", i, i + 1);
      i++;
    }
  }
  return tokens;
}

/** The text of a name token as the database reads it: a quoted name loses its quotes and doubled quotes. */
export function nameOf(token: Token): string {
  return token.type === "quoted"
    ? token.text.slice(1, token.open ? undefined : -1).replace(/""/g, '"')
    : token.text;
}

/** Is the cursor inside a string or a comment, where no name is wanted? */
export function insideStringOrComment(tokens: readonly Token[], offset: number): boolean {
  return tokens.some(
    (t) =>
      (t.type === "string" || t.type === "comment") &&
      t.start < offset &&
      (offset < t.end ||
        t.open ||
        (t.type === "comment" && t.text.startsWith("--") && offset <= t.end)),
  );
}
