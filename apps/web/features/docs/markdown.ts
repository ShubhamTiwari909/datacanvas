/**
 * The Markdown data dictionary: for each schema its tables, and for each table a table of columns, its constraints,
 * its indexes and what it references. Structure only (no row, no value).
 */
import type { ConstraintInfo, TableDetailsEntry } from "@datacanvas/database-core";
import { mdCell, mdCode, mdText, fileStem } from "./quote";
import { relationshipsAmong, type DocFile, type DocInput } from "./types";

const yesNo = (value: boolean): string => (value ? "yes" : "no");

function keyColumns(table: TableDetailsEntry): Set<string> {
  const keys = new Set<string>();
  for (const c of table.constraints)
    if (c.kind === "primary_key") c.columns.forEach((n) => keys.add(n));
  return keys;
}

function constraintLine(c: ConstraintInfo): string {
  const kind = c.kind.replace("_", " ");
  const columns = c.columns.length > 0 ? ` (${c.columns.map((n) => mdCode(n)).join(", ")})` : "";
  const text = c.definition ? `: ${mdCode(c.definition)}` : "";
  return `- ${mdCode(c.name)}: ${kind}${columns}${text}`;
}

export function toMarkdown(input: DocInput): DocFile {
  const lines: string[] = [];
  lines.push(`# ${mdText(input.title)}: data dictionary`, "");
  lines.push(
    "Structure only: table, column, key and index names with their types, defaults, check rules and comments. It holds no row of any table.",
    "",
  );
  const relationships = relationshipsAmong(input);
  let schema: string | null = null;
  for (const entry of input.tables) {
    if (entry.table.schema !== schema) {
      schema = entry.table.schema;
      lines.push(`## Schema ${mdText(schema)}`, "");
    }
    const t = entry.table;
    lines.push(`### ${mdText(t.name)}`, "");
    const facts = [t.kind.replace("_", " ")];
    if (t.estimatedRowCount !== null) {
      facts.push(`about ${t.estimatedRowCount.toLocaleString("en-US")} rows (estimate)`);
    }
    lines.push(facts.join(", "), "");
    // After a fixed word, so a comment that looks like a list item, a fence or a rule is a plain paragraph.
    if (t.comment) lines.push(`Comment: ${mdText(t.comment)}`, "");
    const keys = keyColumns(entry);
    lines.push(
      "| Column | Type | Null | Default | Key | Comment |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const c of entry.columns) {
      lines.push(
        `| ${mdCell(c.name)} | ${mdCell(c.dataType)} | ${yesNo(c.nullable)} | ${mdCell(c.defaultValue)} | ${keys.has(c.name) ? "primary" : ""} | ${mdCell(c.comment)} |`,
      );
    }
    lines.push("");
    if (entry.constraints.length > 0) {
      lines.push("Constraints:", "", ...entry.constraints.map(constraintLine), "");
    }
    if (entry.indexes.length > 0) {
      lines.push("Indexes:", "");
      for (const i of entry.indexes) {
        const kind = [i.method, i.unique ? "unique" : null, i.primary ? "primary" : null]
          .filter(Boolean)
          .join(", ");
        lines.push(`- ${mdCode(i.name)}: ${kind} (${i.columns.map((c) => mdCode(c)).join(", ")})`);
      }
      lines.push("");
    }
    const outgoing = relationships.filter(
      (r) => r.source.schema === t.schema && r.source.table === t.name,
    );
    if (outgoing.length > 0) {
      lines.push("References:", "");
      for (const r of outgoing) {
        lines.push(
          `- ${mdCode(r.source.columns.join(", "))} → ${mdText(r.target.schema)}.${mdText(r.target.table)} (${mdCode(r.target.columns.join(", "))}), ${r.cardinality}, ${mdCode(r.name)}`,
        );
      }
      lines.push("");
    }
  }
  return {
    text: `${lines.join("\n").trimEnd()}\n`,
    fileName: `${fileStem(input.title)}-data-dictionary.md`,
    mimeType: "text/markdown;charset=utf-8",
  };
}
