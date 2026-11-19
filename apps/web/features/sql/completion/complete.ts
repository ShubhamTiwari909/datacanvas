/**
 * Completion for the SQL view, as a pure function of the catalog, the text and the cursor
 * (decision 142 and `docs/sql-workspace-plan.md` section 4). It looks at the statement the
 * cursor is in, finds the relations in its FROM and JOIN clauses (with their aliases), and
 * decides what is wanted at the cursor:
 *
 *   start           the first word of a statement
 *   table           after FROM, JOIN, and a comma in a FROM list: schemas, tables, views, CTEs
 *   after-relation  after a table: ON, WHERE, JOIN, ...
 *   column          elsewhere in a statement: the columns in scope, aliases, functions, keywords
 *   qualified       after `name.`: the columns of that alias or table, or the tables of that schema
 *   none            inside a string or a comment
 *
 * It is a tokenizer and a few rules, not a parser: a name it cannot resolve gives fewer
 * suggestions, never an error. Nothing here touches the network.
 */
import {
  AFTER_RELATION_KEYWORDS,
  BUILTIN_FUNCTIONS,
  CLAUSE_WORDS,
  EXPRESSION_KEYWORDS,
  RESERVED,
  STATEMENT_KEYWORDS,
} from "./keywords";
import { findRelations, fold, matches, type Catalog, type CatalogRelation } from "./catalog";
import { insideStringOrComment, nameOf, tokenize, type Token } from "./tokenize";

export type ItemKind =
  "schema" | "table" | "view" | "column" | "function" | "keyword" | "alias" | "snippet";

export interface CompletionItem {
  label: string;
  kind: ItemKind;
  detail?: string;
  insertText: string;
  /** What the person types to match it (the plain name, even when it is inserted quoted). */
  filterText: string;
  sortText: string;
  /** The text is a Monaco snippet (with tab stops). */
  snippet?: boolean;
  /** Open the list again after inserting it (a schema is followed by `.`). */
  retrigger?: boolean;
}

export type CompletionContext =
  "none" | "start" | "table" | "after-relation" | "column" | "qualified";

export interface Completion {
  context: CompletionContext;
  /** The part of the text the chosen item replaces: the word being typed. */
  replaceFrom: number;
  replaceTo: number;
  items: CompletionItem[];
}

const NONE: Completion = { context: "none", replaceFrom: 0, replaceTo: 0, items: [] };

// ----------------------------------------------------------------- names ---

/** An identifier as it must be written to be read back as the same name. */
export function writeName(name: string, forceQuotes = false): string {
  const plain = /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name);
  return plain && !forceQuotes ? name : `"${name.replace(/"/g, '""')}"`;
}

const isName = (t: Token | undefined): t is Token =>
  t !== undefined && (t.type === "word" || t.type === "quoted");
const isPunct = (t: Token | undefined, char: string): boolean =>
  t?.type === "punct" && t.text === char;
const wordIs = (t: Token | undefined, ...words: string[]): boolean =>
  t?.type === "word" && words.includes(t.text.toLowerCase());

// ----------------------------------------------------------------- scope ---

interface ScopeEntry {
  /** What the statement calls it: the alias, or the table's own name. */
  label: string;
  quoted: boolean;
  relation: CatalogRelation | null;
  /** The parentheses it sits in (an id for each group, outermost first): a subquery's relations are its own. */
  path: number[];
}

/** The ids of the parenthesis groups around each token of a statement, outermost first. */
function groupPaths(tokens: readonly Token[]): number[][] {
  const paths: number[][] = [];
  const stack: number[] = [];
  let next = 0;
  for (const t of tokens) {
    if (isPunct(t, ")")) stack.pop();
    paths.push([...stack]);
    if (isPunct(t, "(")) stack.push(next++);
  }
  return paths;
}

const isPrefix = (inner: readonly number[], outer: readonly number[]): boolean =>
  inner.length <= outer.length && inner.every((id, i) => outer[i] === id);

/**
 * The relations a statement reads, from its FROM and JOIN clauses, and the names of its CTEs.
 * With a cursor offset, only the relations the cursor can see: those of its own query and of the
 * queries around it, not those of a subquery it is not in.
 */
export function readScope(
  catalog: Catalog | null,
  statement: readonly Token[],
  cursor?: number,
): { entries: ScopeEntry[]; ctes: string[] } {
  const entries: ScopeEntry[] = [];
  const ctes: string[] = [];
  const cteKeys: string[] = [];
  const tokens = statement.filter((t) => t.type !== "comment");
  const paths = groupPaths(tokens);

  // WITH name AS ( ... ), name2 AS ( ... )
  if (wordIs(tokens[0], "with")) {
    let depth = 0;
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (isPunct(t, "(")) depth++;
      else if (isPunct(t, ")")) depth--;
      else if (
        depth === 0 &&
        isName(t) &&
        wordIs(tokens[i + 1], "as") &&
        isPunct(tokens[i + 2], "(")
      ) {
        ctes.push(nameOf(t));
        cteKeys.push(fold(nameOf(t), t.type === "quoted"));
      }
    }
  }

  const skipGroup = (from: number): number => {
    let depth = 0;
    let i = from;
    for (; i < tokens.length; i++) {
      if (isPunct(tokens[i], "(")) depth++;
      else if (isPunct(tokens[i], ")") && --depth === 0) return i + 1;
    }
    return i;
  };

  /** One relation after FROM, JOIN or a comma: `[schema.]name [[AS] alias]` or `(subquery) [AS] alias`. */
  const readRef = (from: number, path: number[]): number => {
    let i = from;
    while (wordIs(tokens[i], "lateral", "only")) i++;
    let label: string | null = null;
    let quoted = false;
    let relation: CatalogRelation | null = null;
    if (isPunct(tokens[i], "(")) {
      i = skipGroup(i);
    } else if (isName(tokens[i])) {
      const parts: Token[] = [tokens[i]!];
      i++;
      while (isPunct(tokens[i], ".") && isName(tokens[i + 1])) {
        parts.push(tokens[i + 1]!);
        i += 2;
      }
      const last = parts[parts.length - 1]!;
      label = nameOf(last);
      quoted = last.type === "quoted";
      // A CTE of that name hides a table of the same name; one with a schema in front does not.
      const shadowed = parts.length === 1 && cteKeys.includes(fold(label, quoted));
      if (catalog && !shadowed) {
        const schemaToken = parts.length >= 2 ? parts[parts.length - 2]! : null;
        const found = findRelations(
          catalog,
          schemaToken ? { name: nameOf(schemaToken), quoted: schemaToken.type === "quoted" } : null,
          label,
          quoted,
        );
        relation = found[0] ?? null;
      }
    } else {
      return i;
    }
    if (wordIs(tokens[i], "as")) i++;
    const alias = tokens[i];
    if (isName(alias) && !(alias.type === "word" && CLAUSE_WORDS.has(alias.text.toLowerCase()))) {
      entries.push({ label: nameOf(alias), quoted: alias.type === "quoted", relation, path });
      i++;
    } else if (label !== null) {
      entries.push({ label, quoted, relation, path });
    }
    return i;
  };

  for (let i = 0; i < tokens.length; i++) {
    const path = paths[i]!;
    if (wordIs(tokens[i], "from")) {
      i = readRef(i + 1, path) - 1;
      while (isPunct(tokens[i + 1], ",")) i = readRef(i + 2, path) - 1;
    } else if (wordIs(tokens[i], "join")) {
      i = readRef(i + 1, path) - 1;
    }
  }

  if (cursor === undefined) return { entries, ctes };
  // The groups the cursor is in: those opened before it and not yet closed.
  const before = tokens.filter((t) => t.end <= cursor);
  const here =
    before.length > 0
      ? [
          ...(groupPaths([
            ...before,
            { ...before[0]!, type: "word", text: "", start: cursor, end: cursor, open: false },
          ]).at(-1) ?? []),
        ]
      : [];
  return { entries: entries.filter((e) => isPrefix(e.path, here)), ctes };
}

// --------------------------------------------------------------- context ---

const TABLE_WORDS = ["from", "join", "update", "into", "table"];
const COLUMN_WORDS = [
  "select",
  "where",
  "on",
  "by",
  "group",
  "order",
  "having",
  "set",
  "when",
  "and",
  "or",
];
const CLAUSE_KEYWORDS = [...TABLE_WORDS, ...COLUMN_WORDS, "with", "values", "limit", "offset"];

/** What is wanted after the tokens before the cursor, when no `name.` is in front of it. */
function contextBefore(before: readonly Token[]): CompletionContext {
  const meaningful = before.filter((t) => t.type !== "comment");
  const prev = meaningful.at(-1);
  if (!prev) return "start";
  // Walk back to the clause the cursor is in, skipping groups that are already closed.
  let depth = 0;
  for (let i = meaningful.length - 1; i >= 0; i--) {
    const t = meaningful[i]!;
    if (isPunct(t, ")")) depth++;
    else if (isPunct(t, "(")) {
      if (depth > 0) depth--;
    } else if (depth === 0 && t.type === "word" && CLAUSE_KEYWORDS.includes(t.text.toLowerCase())) {
      const word = t.text.toLowerCase();
      if (word === "from" || word === "join") {
        const beforePrev = meaningful.at(-2);
        const at =
          i === meaningful.length - 1 || isPunct(prev, ",") || wordIs(prev, "lateral", "only");
        // `FROM (` starts a subquery.
        if (isPunct(prev, "(") && i === meaningful.length - 2) return "start";
        return at && !(isPunct(prev, ",") && word === "join")
          ? "table"
          : beforePrev
            ? "after-relation"
            : "table";
      }
      if (word === "update" || word === "into" || word === "table") {
        return i === meaningful.length - 1 ? "table" : "column";
      }
      if (word === "with" || word === "values" || word === "limit" || word === "offset")
        return "none";
      return "column";
    }
  }
  return "start";
}

// --------------------------------------------------------------- the items ---

/** Group first, then the name: the same text always gives the same order. */
const sort = (group: number, label: string): string => `${group}${label.toLowerCase()}`;

const relationKind = (r: CatalogRelation): ItemKind => (r.kind === "table" ? "table" : "view");

function relationItems(
  catalog: Catalog,
  relations: readonly CatalogRelation[],
  qualifyAmbiguous: boolean,
  forceQuotes: boolean,
): CompletionItem[] {
  const counts = new Map<string, number>();
  for (const r of catalog.relations)
    counts.set(r.name.toLowerCase(), (counts.get(r.name.toLowerCase()) ?? 0) + 1);
  return relations.map((r) => {
    // A name that exists in several schemas is inserted with its schema, unless it is the public one.
    const ambiguous =
      qualifyAmbiguous && r.schema !== "public" && (counts.get(r.name.toLowerCase()) ?? 0) > 1;
    const name = writeName(r.name, forceQuotes);
    return {
      label: r.name,
      kind: relationKind(r),
      detail: `${r.schema} · ${r.kind.replace("_", " ")}`,
      insertText: ambiguous ? `${writeName(r.schema)}.${name}` : name,
      filterText: r.name,
      sortText: sort(r.schema === "public" ? 0 : 1, r.name),
    };
  });
}

function columnItems(
  relation: CatalogRelation,
  owner: string,
  forceQuotes: boolean,
  group: number,
): CompletionItem[] {
  return relation.columns.map((c) => ({
    label: c.name,
    kind: "column" as const,
    detail: `${owner} · ${c.dataType}`,
    insertText: writeName(c.name, forceQuotes),
    filterText: c.name,
    sortText: sort(group, c.name),
  }));
}

function keywordItems(words: readonly string[], group: number): CompletionItem[] {
  return words.map((w) => ({
    label: w,
    kind: "keyword" as const,
    insertText: w,
    filterText: w,
    sortText: sort(group, w),
  }));
}

function functionItems(
  catalog: Catalog | null,
  forceQuotes: boolean,
  group: number,
): CompletionItem[] {
  const own = (catalog?.functions ?? []).map((f) => ({
    label: f.name,
    kind: "function" as const,
    detail: `${f.schema}.${f.name}(${f.arguments})${f.returns ? ` → ${f.returns}` : ""}`,
    insertText: `${writeName(f.name, forceQuotes)}(`,
    filterText: f.name,
    sortText: sort(group, f.name),
  }));
  const builtin = BUILTIN_FUNCTIONS.map((f) => ({
    label: f,
    kind: "function" as const,
    detail: "built-in",
    insertText: `${f}(`,
    filterText: f,
    sortText: sort(group + 1, f),
  }));
  return [...own, ...builtin];
}

const SNIPPETS: CompletionItem[] = [
  {
    label: "select … from",
    kind: "snippet",
    detail: "snippet",
    insertText: "SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:true}\nLIMIT ${4:100}",
    filterText: "select from where limit sel",
    sortText: "9snippet0",
    snippet: true,
  },
  {
    label: "join … on",
    kind: "snippet",
    detail: "snippet",
    insertText: "JOIN ${1:table} ${2:t} ON ${2:t}.${3:id} = ${4:other}.${5:id}",
    filterText: "join on",
    sortText: "9snippet1",
    snippet: true,
  },
];

// ---------------------------------------------------------------- complete ---

export function complete(catalog: Catalog | null, text: string, offset: number): Completion {
  const tokens = tokenize(text);
  if (insideStringOrComment(tokens, offset)) return NONE;

  // The word being typed: the name token the cursor is in or at the end of.
  const partial = tokens.find(
    (t) =>
      (t.type === "word" || (t.type === "quoted" && (t.open || offset < t.end))) &&
      t.start < offset &&
      offset <= t.end,
  );
  const replaceFrom = partial?.start ?? offset;
  const replaceTo = partial?.end ?? offset;
  const forceQuotes = partial?.type === "quoted";

  // The statement the cursor is in.
  const semicolons = tokens.filter((t) => isPunct(t, ";"));
  const stmtStart = semicolons.filter((t) => t.end <= replaceFrom).at(-1)?.end ?? 0;
  const stmtEnd = semicolons.find((t) => t.start >= replaceTo)?.start ?? text.length;
  const statement = tokens.filter((t) => t.start >= stmtStart && t.end <= stmtEnd);
  const before = statement.filter((t) => t.end <= replaceFrom);

  const done = (context: CompletionContext, items: CompletionItem[]): Completion => ({
    context,
    replaceFrom,
    replaceTo,
    items,
  });

  // `name.` or `schema.name.` in front of the word.
  const chain: Token[] = [];
  let at = before.length - 1;
  while (isPunct(before[at], ".") && isName(before[at - 1])) {
    chain.unshift(before[at - 1]!);
    at -= 2;
  }
  if (chain.length === 0 && isPunct(before.at(-1), ".")) return NONE; // `).` or a stray dot: nothing to say
  const last = before.at(-1);
  if (!partial && last?.type === "number" && last.text.endsWith(".") && last.end === offset)
    return NONE; // `1.`

  const { entries, ctes } = readScope(catalog, statement, replaceFrom);

  if (chain.length > 0) {
    if (!catalog) return done("qualified", []);
    const first = nameOf(chain[0]!);
    const firstQuoted = chain[0]!.type === "quoted";
    if (chain.length === 1) {
      const items: CompletionItem[] = [];
      const hit = entries.find((e) => fold(e.label, e.quoted) === fold(first, firstQuoted));
      if (hit?.relation) items.push(...columnItems(hit.relation, hit.label, forceQuotes, 0));
      else if (!hit) {
        for (const r of findRelations(catalog, null, first, firstQuoted).slice(0, 1)) {
          items.push(...columnItems(r, r.name, forceQuotes, 0));
        }
      }
      if (catalog.schemas.some((s) => matches(s, first, firstQuoted))) {
        const inSchema = catalog.relations.filter((r) => matches(r.schema, first, firstQuoted));
        items.push(...relationItems(catalog, inSchema, false, forceQuotes));
        const wantsFunctions = contextBefore(before.slice(0, before.length - 2)) === "column";
        if (wantsFunctions) {
          items.push(
            ...functionItems(
              {
                ...catalog,
                functions: catalog.functions.filter((f) => matches(f.schema, first, firstQuoted)),
              },
              forceQuotes,
              2,
            ).filter((i) => i.detail !== "built-in"),
          );
        }
      }
      return done("qualified", items);
    }
    if (chain.length === 2) {
      const relation = findRelations(
        catalog,
        { name: first, quoted: firstQuoted },
        nameOf(chain[1]!),
        chain[1]!.type === "quoted",
      )[0];
      return done(
        "qualified",
        relation ? columnItems(relation, relation.name, forceQuotes, 0) : [],
      );
    }
    return done("qualified", []);
  }

  const context = contextBefore(before);
  switch (context) {
    case "start":
      return done("start", [...keywordItems(STATEMENT_KEYWORDS, 0), ...SNIPPETS]);
    case "table": {
      const items: CompletionItem[] = [];
      if (catalog) {
        items.push(...relationItems(catalog, catalog.relations, true, forceQuotes));
        items.push(
          ...catalog.schemas.map((s) => ({
            label: s,
            kind: "schema" as const,
            detail: "schema",
            insertText: `${writeName(s, forceQuotes)}.`,
            filterText: s,
            sortText: sort(2, s),
            retrigger: true,
          })),
        );
      }
      items.push(
        ...ctes.map((c) => ({
          label: c,
          kind: "table" as const,
          detail: "CTE",
          insertText: writeName(c, forceQuotes),
          filterText: c,
          sortText: sort(0, c),
        })),
      );
      return done("table", items);
    }
    case "after-relation":
      return done("after-relation", keywordItems(AFTER_RELATION_KEYWORDS, 0));
    case "none":
      return done("none", []);
    case "column": {
      const items: CompletionItem[] = [];
      for (const e of entries) {
        if (e.relation) items.push(...columnItems(e.relation, e.label, forceQuotes, 0));
      }
      // What a `name.` can start: the aliases and tables of the statement.
      for (const e of entries) {
        items.push({
          label: e.label,
          kind: "alias",
          detail: e.relation ? `${e.relation.schema}.${e.relation.name}` : "alias",
          insertText: writeName(e.label, forceQuotes),
          filterText: e.label,
          sortText: sort(1, e.label),
        });
      }
      items.push(...functionItems(catalog, forceQuotes, 2));
      items.push(...keywordItems(EXPRESSION_KEYWORDS, 4));
      return done("column", items);
    }
    default:
      return done(context, []);
  }
}
