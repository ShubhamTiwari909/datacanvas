/**
 * Pure helpers for the Objects tab: filtering by name, which views read a
 * relation, and policies grouped per table with the two row-level-security
 * situations that are easy to miss.
 */
import {
  displayName,
  type DatabaseObjects,
  type ObjectKind,
  type PolicyInfo,
  type ViewInfo,
} from "@datacanvas/database-core";

/** Items of one kind whose display name contains `query` (case-insensitive). A blank query keeps everything. */
export function filterObjects<K extends ObjectKind>(
  kind: K,
  items: readonly DatabaseObjects[K][number][],
  query: string,
): DatabaseObjects[K][number][] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...items];
  const name = displayName[kind] as (item: DatabaseObjects[K][number]) => string;
  return items.filter((item) => name(item).toLowerCase().includes(needle));
}

const relationKey = (schema: string, name: string): string => JSON.stringify([schema, name]);

/** For each table or view, the views whose query reads it. A view that reads itself is not counted. */
export function viewReaders(views: readonly ViewInfo[]): Map<string, ViewInfo[]> {
  const readers = new Map<string, ViewInfo[]>();
  for (const view of views) {
    for (const dependency of view.dependsOn) {
      if (dependency.schema === view.schema && dependency.name === view.name) continue;
      const key = relationKey(dependency.schema, dependency.name);
      readers.set(key, [...(readers.get(key) ?? []), view]);
    }
  }
  return readers;
}

/** Views that read the given relation (empty if none). */
export function readersOf(
  readers: ReadonlyMap<string, ViewInfo[]>,
  schema: string,
  name: string,
): ViewInfo[] {
  return readers.get(relationKey(schema, name)) ?? [];
}

export interface PolicyGroup {
  schema: string;
  table: string;
  /** Row-level security is switched on for the table. */
  enabled: boolean;
  forced: boolean;
  policies: PolicyInfo[];
  /**
   * What is easy to miss:
   *  - "no_policies": security is ON but there are no policies, so every row is hidden from roles that are not exempt (the owner and superusers are);
   *  - "inactive": policies exist but security is OFF, so they have no effect at all.
   */
  warning: "no_policies" | "inactive" | null;
}

export function policyGroups(objects: DatabaseObjects): PolicyGroup[] {
  const groups = new Map<string, PolicyGroup>();
  const group = (schema: string, table: string): PolicyGroup => {
    const key = relationKey(schema, table);
    let found = groups.get(key);
    if (!found) {
      found = { schema, table, enabled: false, forced: false, policies: [], warning: null };
      groups.set(key, found);
    }
    return found;
  };
  for (const r of objects.rowSecurity) {
    const g = group(r.schema, r.table);
    g.enabled = true;
    g.forced = r.forced;
  }
  for (const p of objects.policies) group(p.schema, p.table).policies.push(p);
  for (const g of groups.values()) {
    g.warning =
      g.enabled && g.policies.length === 0
        ? "no_policies"
        : !g.enabled && g.policies.length > 0
          ? "inactive"
          : null;
  }
  return [...groups.values()].sort(
    (a, b) =>
      (a.schema < b.schema ? -1 : a.schema > b.schema ? 1 : 0) ||
      (a.table < b.table ? -1 : a.table > b.table ? 1 : 0),
  );
}
