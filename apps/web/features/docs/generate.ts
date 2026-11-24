import { toDbml } from "./dbml";
import { toMarkdown } from "./markdown";
import { toMermaid } from "./mermaid";
import { toPlantUml } from "./plantuml";
import { sortTables, type DocFile, type DocFormat, type DocInput } from "./types";

/** One file, in the chosen format, from the structure. The tables are put in a fixed order first. */
export function generateDoc(format: DocFormat, input: DocInput): DocFile {
  const sorted: DocInput = { ...input, tables: sortTables(input.tables) };
  switch (format) {
    case "markdown":
      return toMarkdown(sorted);
    case "mermaid":
      return toMermaid(sorted);
    case "dbml":
      return toDbml(sorted);
    case "plantuml":
      return toPlantUml(sorted);
  }
}

export const FORMAT_LABEL: Record<DocFormat, { name: string; note: string }> = {
  markdown: {
    name: "Markdown data dictionary",
    note: "Tables, columns, keys, indexes and references, as a document.",
  },
  mermaid: { name: "Mermaid diagram", note: "An erDiagram for GitHub, GitLab and Mermaid Live." },
  dbml: { name: "DBML", note: "For dbdiagram.io and other DBML tools." },
  plantuml: { name: "PlantUML diagram", note: "An entity-relationship diagram for PlantUML." },
};
