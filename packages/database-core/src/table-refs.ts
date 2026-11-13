/**
 * Small helpers for lists of `TableRef`s, shared by every adapter so they all
 * treat duplicates the same way.
 */
import type { TableRef } from "./models.js";

/**
 * A string that identifies a table and is safe to use as a Map key.
 *
 * JSON encoding makes it unambiguous: schema "a.b" with table "c" and schema
 * "a" with table "b.c" would collide if we simply joined them with a dot.
 */
export function tableRefKey(ref: TableRef): string {
  return JSON.stringify([ref.schema, ref.name]);
}

/** Remove repeated tables, keeping the order of first appearance. */
export function uniqueTableRefs(refs: readonly TableRef[]): TableRef[] {
  const seen = new Set<string>();
  const unique: TableRef[] = [];
  for (const ref of refs) {
    const key = tableRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ schema: ref.schema, name: ref.name });
  }
  return unique;
}
