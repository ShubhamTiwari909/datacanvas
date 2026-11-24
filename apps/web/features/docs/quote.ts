/**
 * Quoting for the text formats of the documentation exports. A name in a database can hold ANY character, including
 * quotes, a pipe, brackets, a line break and a string that looks like the next line of a file: each format needs its
 * names written so that they stay a name. Everything here is pure and tested with hostile names.
 */

/** Line breaks and control characters (the ones a line-based format ends a line at) become a space; length is capped. */
export function oneLine(text: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** A Markdown table cell: one line, the pipe and the backslash escaped, and markup characters made plain. */
export function mdCell(text: string | null): string {
  if (text === null || text === "") return "";
  return oneLine(text, 500)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/([`*_[\]<>])/g, "\\$1");
}

/** Text in a Markdown heading or paragraph: one line, with markup characters made plain. */
export function mdText(text: string): string {
  return oneLine(text, 300).replace(/([\\`*_[\]<>#|])/g, "\\$1");
}

/** A name in code spans: backticks cannot be inside, so they become the apostrophe. */
export function mdCode(text: string): string {
  return `\`${oneLine(text, 300).replace(/`/g, "'")}\``;
}

/** A DBML identifier: always in double quotes, with the quote and the backslash escaped. */
export function dbmlName(text: string): string {
  return `"${oneLine(text, 255).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A DBML type: as written when it is a plain type (`integer`, `varchar(20)`, `text[]`), else quoted. */
export function dbmlType(text: string): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_]*(\([0-9, ]{1,20}\))?(\[\])?$/;
  const flat = oneLine(text, 255);
  return plain.test(flat) ? flat : dbmlName(flat);
}

/** A DBML note or string: single quotes, the quote and the backslash escaped, on one line. */
export function dbmlString(text: string): string {
  return `'${oneLine(text, 500).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** A DBML expression in backticks (a default): a backtick cannot be inside it. */
export function dbmlExpression(text: string): string {
  return `\`${oneLine(text, 500).replace(/`/g, "'")}\``;
}

/** A Mermaid entity name: in double quotes, with the quote made an apostrophe (Mermaid has no escape for it). */
export function mermaidEntity(text: string): string {
  return `"${oneLine(text, 200).replace(/"/g, "'")}"`;
}

/** A Mermaid attribute name or type: letters, digits and underscore only (the grammar allows little more). */
export function mermaidWord(text: string, fallback = "x"): string {
  const word = oneLine(text, 100)
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return word === "" ? fallback : /^[0-9]/.test(word) ? `_${word}` : word;
}

/** A Mermaid label: in double quotes, with the quote made an apostrophe. */
export function mermaidLabel(text: string): string {
  return `"${oneLine(text, 100).replace(/"/g, "'")}"`;
}

/** A PlantUML alias: letters, digits and underscore, made unique by the caller with a number. */
export function plantAlias(index: number): string {
  return `t${index + 1}`;
}

/** A PlantUML display name: in double quotes, with the quote made an apostrophe. */
export function plantName(text: string): string {
  return `"${oneLine(text, 200).replace(/"/g, "'")}"`;
}

/** Text inside a PlantUML entity body: one line that cannot start with `}` (which would close the entity). */
export function plantLine(text: string): string {
  const flat = oneLine(text, 300);
  return flat.startsWith("}") ? `\\${flat}` : flat;
}

/** A file name from a title: letters, digits, dot, dash and underscore, never empty, never a path. */
export function fileStem(title: string): string {
  const stem = title.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
  return stem === "" ? "database" : stem.slice(0, 60);
}
