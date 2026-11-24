/**
 * DBML (dbdiagram.io) for the chosen tables and the foreign keys between them. Every identifier is in double quotes,
 * every string single-quoted, every default an expression in backticks: nothing a name holds can end the line it is on.
 */
import { dbmlExpression, dbmlName, dbmlString, dbmlType, fileStem } from "./quote";
import { relationshipsAmong, type DocFile, type DocInput } from "./types";

const qualified = (schema: string, table: string): string =>
  `${dbmlName(schema)}.${dbmlName(table)}`;

function endOf(schema: string, table: string, columns: readonly string[]): string {
  return columns.length === 1
    ? `${qualified(schema, table)}.${dbmlName(columns[0]!)}`
    : `${qualified(schema, table)}.(${columns.map((c) => dbmlName(c)).join(", ")})`;
}

export function toDbml(input: DocInput): DocFile {
  const lines: string[] = [];
  for (const entry of input.tables) {
    const primary = new Set<string>();
    const unique = new Set<string>();
    for (const c of entry.constraints) {
      if (c.kind === "primary_key") c.columns.forEach((n) => primary.add(n));
      // A unique constraint of ONE column is the column's own setting; a composite one is not written here.
      if (c.kind === "unique" && c.columns.length === 1) unique.add(c.columns[0]!);
    }
    lines.push(`Table ${qualified(entry.table.schema, entry.table.name)} {`);
    for (const c of entry.columns) {
      const settings: string[] = [];
      if (primary.has(c.name) && primary.size === 1) settings.push("pk");
      if (!c.nullable) settings.push("not null");
      if (unique.has(c.name)) settings.push("unique");
      if (c.defaultValue !== null) settings.push(`default: ${dbmlExpression(c.defaultValue)}`);
      if (c.comment) settings.push(`note: ${dbmlString(c.comment)}`);
      lines.push(
        `  ${dbmlName(c.name)} ${dbmlType(c.dataType)}${settings.length > 0 ? ` [${settings.join(", ")}]` : ""}`,
      );
    }
    if (primary.size > 1) {
      lines.push(
        "",
        "  indexes {",
        `    (${[...primary].map((n) => dbmlName(n)).join(", ")}) [pk]`,
        "  }",
      );
    }
    if (entry.table.comment) lines.push("", `  Note: ${dbmlString(entry.table.comment)}`);
    lines.push("}", "");
  }
  for (const r of relationshipsAmong(input)) {
    // `>` many-to-one (the referencing side holds many), `-` one-to-one.
    const arrow = r.cardinality === "one-to-one" ? "-" : ">";
    lines.push(
      `Ref ${dbmlName(r.name)}: ${endOf(r.source.schema, r.source.table, r.source.columns)} ${arrow} ${endOf(r.target.schema, r.target.table, r.target.columns)}`,
    );
  }
  return {
    text: `${lines.join("\n").trimEnd()}\n`,
    fileName: `${fileStem(input.title)}.dbml`,
    mimeType: "text/plain;charset=utf-8",
  };
}
