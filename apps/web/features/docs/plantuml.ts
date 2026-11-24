/**
 * A PlantUML entity-relationship diagram (information engineering notation) of the chosen tables and the foreign keys
 * between them. Each entity has a generated alias (`t1`, `t2`...), so no name is ever used as an identifier: it is only
 * ever a quoted display name or text inside the entity.
 */
import { plantAlias, plantLine, plantName, fileStem } from "./quote";
import { keyOf, relationshipsAmong, type DocFile, type DocInput } from "./types";

export function toPlantUml(input: DocInput): DocFile {
  const lines: string[] = ["@startuml", "hide circle", "skinparam linetype ortho", ""];
  const alias = new Map<string, string>();
  input.tables.forEach((entry, i) =>
    alias.set(keyOf(entry.table.schema, entry.table.name), plantAlias(i)),
  );
  for (const entry of input.tables) {
    const primary = new Set<string>();
    for (const c of entry.constraints)
      if (c.kind === "primary_key") c.columns.forEach((n) => primary.add(n));
    const id = alias.get(keyOf(entry.table.schema, entry.table.name))!;
    lines.push(`entity ${plantName(`${entry.table.schema}.${entry.table.name}`)} as ${id} {`);
    const keyColumns = entry.columns.filter((c) => primary.has(c.name));
    const others = entry.columns.filter((c) => !primary.has(c.name));
    for (const c of keyColumns) lines.push(`  * ${plantLine(`${c.name} : ${c.dataType}`)} <<PK>>`);
    if (keyColumns.length > 0 && others.length > 0) lines.push("  --");
    for (const c of others) {
      lines.push(`  ${c.nullable ? "" : "* "}${plantLine(`${c.name} : ${c.dataType}`)}`);
    }
    lines.push("}", "");
  }
  for (const r of relationshipsAmong(input)) {
    const from = alias.get(keyOf(r.source.schema, r.source.table))!;
    const to = alias.get(keyOf(r.target.schema, r.target.table))!;
    // From the referenced table (one) to the referencing one (many, or one when its columns are unique too).
    lines.push(
      `${to} ||--${r.cardinality === "one-to-one" ? "o|" : "o{"} ${from} : ${plantName(r.name)}`,
    );
  }
  lines.push("@enduml");
  return {
    text: `${lines.join("\n")}\n`,
    fileName: `${fileStem(input.title)}.puml`,
    mimeType: "text/plain;charset=utf-8",
  };
}
