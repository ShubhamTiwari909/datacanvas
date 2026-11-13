/**
 * "How do I get from table A to table B?": find the shortest chains of declared
 * foreign keys between two tables, and write the join that follows a chain.
 *
 * Pure functions over the database's relationships. Nothing is guessed (only
 * real foreign keys are followed) and the SQL is text for the user to copy:
 * DataCanvas cannot run it.
 *
 * Foreign keys are followed in BOTH directions (from a child to its parent and
 * from a parent to its children), because a join does not care which table
 * holds the key. The direction is kept, though, because walking from a parent
 * to its children can return many rows per parent row, which the user should
 * know before running the query.
 */
import type { RelationshipInfo } from "@datacanvas/database-core";
import { quoteIdent, quoteQualified } from "@/lib/sql-text";

export interface TableKey {
  schema: string;
  table: string;
}

/** How many alternative shortest paths are returned at most. */
export const MAX_PATHS = 5;

export interface PathStep {
  relationship: RelationshipInfo;
  from: TableKey;
  to: TableKey;
  /**
   * "references": `from` holds the foreign key (child to parent, at most one row).
   * "referenced_by": `from` is the parent and `to` holds the key (one to many).
   */
  direction: "references" | "referenced_by";
  /** Columns to compare, aligned by position: fromColumns[i] = toColumns[i]. */
  fromColumns: string[];
  toColumns: string[];
}

export interface FoundPath {
  /** The tables in order, from the start to the end. */
  tables: TableKey[];
  steps: PathStep[];
  /** True when a step goes from a parent to its children, so one start row can match many. */
  multipliesRows: boolean;
}

export type PathSearch =
  | { status: "same_table" }
  | { status: "none" }
  | {
      status: "found";
      /** Number of joins (steps) in every returned path. */
      length: number;
      paths: FoundPath[];
      /** True when more shortest paths exist than were returned. */
      truncated: boolean;
    };

const keyOf = (t: TableKey): string => JSON.stringify([t.schema, t.table]);

interface Edge {
  relationship: RelationshipInfo;
  from: string;
  to: TableKey;
  direction: PathStep["direction"];
}

/** Both directions of every relationship, grouped by the table they start from. A self-reference leads nowhere new, so it is left out. */
function adjacency(relationships: RelationshipInfo[]): Map<string, Edge[]> {
  const map = new Map<string, Edge[]>();
  const push = (edge: Edge): void => {
    map.set(edge.from, [...(map.get(edge.from) ?? []), edge]);
  };
  for (const relationship of relationships) {
    const source: TableKey = {
      schema: relationship.source.schema,
      table: relationship.source.table,
    };
    const target: TableKey = {
      schema: relationship.target.schema,
      table: relationship.target.table,
    };
    if (keyOf(source) === keyOf(target)) continue;
    push({ relationship, from: keyOf(source), to: target, direction: "references" });
    push({ relationship, from: keyOf(target), to: source, direction: "referenced_by" });
  }
  return map;
}

function toStep(edge: Edge, from: TableKey): PathStep {
  const { relationship, direction } = edge;
  const referencing = direction === "references";
  return {
    relationship,
    from,
    to: edge.to,
    direction,
    fromColumns: referencing ? relationship.source.columns : relationship.target.columns,
    toColumns: referencing ? relationship.target.columns : relationship.source.columns,
  };
}

/**
 * Find the shortest paths from `from` to `to` (fewest joins), at most
 * `maxPaths` of them, in a stable order. Several foreign keys between the same
 * two tables (billing and shipping address, say) count as different paths.
 */
export function findPaths(
  relationships: RelationshipInfo[],
  from: TableKey,
  to: TableKey,
  maxPaths: number = MAX_PATHS,
): PathSearch {
  const start = keyOf(from);
  const goal = keyOf(to);
  if (start === goal) return { status: "same_table" };

  const edges = adjacency(relationships);

  // Breadth-first search from the start. `parents` records, for each table, every
  // edge that reaches it in the fewest steps, so ALL shortest paths can be rebuilt.
  const distance = new Map<string, number>([[start, 0]]);
  const parents = new Map<string, Edge[]>();
  const queue: string[] = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head] as string;
    const next = (distance.get(current) as number) + 1;
    for (const edge of edges.get(current) ?? []) {
      const target = keyOf(edge.to);
      const known = distance.get(target);
      if (known === undefined) {
        distance.set(target, next);
        parents.set(target, [edge]);
        queue.push(target);
      } else if (known === next) {
        parents.get(target)?.push(edge);
      }
    }
  }

  const length = distance.get(goal);
  if (length === undefined) return { status: "none" };

  // Walk back from the goal, one parent edge at a time. Stop as soon as one path
  // more than requested exists, which is enough to know the list was cut.
  const reversed: Edge[][] = [];
  const walk = (key: string, tail: Edge[]): void => {
    if (reversed.length > maxPaths) return;
    if (key === start) {
      reversed.push(tail);
      return;
    }
    const options = [...(parents.get(key) ?? [])].sort(
      (a, b) =>
        a.relationship.name.localeCompare(b.relationship.name) || a.from.localeCompare(b.from),
    );
    for (const edge of options) walk(edge.from, [edge, ...tail]);
  };
  walk(goal, []);

  const found = reversed.slice(0, maxPaths).map((edges): FoundPath => {
    const steps: PathStep[] = [];
    let current = from;
    for (const edge of edges) {
      steps.push(toStep(edge, current));
      current = edge.to;
    }
    return {
      tables: [from, ...steps.map((s) => s.to)],
      steps,
      multipliesRows: steps.some((s) => s.direction === "referenced_by"),
    };
  });
  return { status: "found", length, paths: found, truncated: reversed.length > maxPaths };
}

/**
 * The SELECT that follows a path. Tables are aliased t1, t2, ... (a table named
 * `user` or `order` would need quoting as an alias, and the numbering is short
 * to read). Every name is quoted. `LIMIT 100` keeps an accidental paste from
 * pulling a whole table.
 */
export function buildJoinSql(path: FoundPath): string {
  const first = path.tables[0];
  if (!first) return "";
  const lines = [`SELECT *`, `FROM ${quoteQualified(first.schema, first.table)} AS t1`];
  path.steps.forEach((step, i) => {
    const left = `t${i + 1}`;
    const right = `t${i + 2}`;
    const condition = step.fromColumns
      .map(
        (column, k) =>
          `${left}.${quoteIdent(column)} = ${right}.${quoteIdent(step.toColumns[k] ?? "")}`,
      )
      .join(" AND ");
    lines.push(`JOIN ${quoteQualified(step.to.schema, step.to.table)} AS ${right} ON ${condition}`);
  });
  lines.push("LIMIT 100;");
  return lines.join("\n");
}
