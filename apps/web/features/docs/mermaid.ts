/**
 * A Mermaid `erDiagram` of the chosen tables and the foreign keys between them. Mermaid's grammar allows little in an
 * attribute name or a type (letters, digits, underscore), so those are made into words; an entity name is in quotes and
 * carries the schema, so two schemas can hold the same table name.
 */
import { mermaidEntity, mermaidLabel, mermaidWord, fileStem } from "./quote";
import { relationshipsAmong, type DocFile, type DocInput } from "./types";

const entityName = (schema: string, name: string): string => mermaidEntity(`${schema}.${name}`);

export function toMermaid(input: DocInput): DocFile {
  const lines: string[] = ["erDiagram"];
  for (const entry of input.tables) {
    const primary = new Set<string>();
    const foreign = new Set<string>();
    const unique = new Set<string>();
    for (const c of entry.constraints) {
      const into =
        c.kind === "primary_key"
          ? primary
          : c.kind === "foreign_key"
            ? foreign
            : c.kind === "unique"
              ? unique
              : null;
      if (into) c.columns.forEach((n) => into.add(n));
    }
    lines.push(`  ${entityName(entry.table.schema, entry.table.name)} {`);
    for (const c of entry.columns) {
      const marks = [
        primary.has(c.name) ? "PK" : null,
        foreign.has(c.name) ? "FK" : null,
        unique.has(c.name) ? "UK" : null,
      ]
        .filter((m): m is string => m !== null)
        .join(",");
      lines.push(
        `    ${mermaidWord(c.dataType, "type")} ${mermaidWord(c.name, "column")}${marks ? ` ${marks}` : ""}`,
      );
    }
    lines.push("  }");
  }
  for (const r of relationshipsAmong(input)) {
    // The referenced side is "one" (or zero when the key is nullable: not told here), the referencing side is many,
    // or one when its columns are unique too.
    const many = r.cardinality === "one-to-one" ? "o|" : "o{";
    lines.push(
      `  ${entityName(r.target.schema, r.target.table)} ||--${many} ${entityName(r.source.schema, r.source.table)} : ${mermaidLabel(r.name)}`,
    );
  }
  return {
    text: `${lines.join("\n")}\n`,
    fileName: `${fileStem(input.title)}-er.mmd`,
    mimeType: "text/plain;charset=utf-8",
  };
}
