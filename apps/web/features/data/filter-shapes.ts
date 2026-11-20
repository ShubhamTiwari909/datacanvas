/**
 * Saved filter shapes: the columns and conditions of a filter, WITHOUT their values.
 *
 * A condition's value is what a person typed or clicked to look for something, and may be a
 * name, an address or a key; it is never saved (decision of the data viewer, kept in the plan of
 * the advanced data workspace, section 4). What is saved is the shape ("status is ?, created is in
 * the last 7 days"), per table, in the browser's local storage: column names and condition kinds,
 * which are structure. Using a shape asks for the values again.
 *
 * Storage can be missing or refuse (a private window, blocked site data): every access is guarded,
 * and the feature then simply remembers nothing.
 */
import {
  ROW_FILTER_OPS,
  ROWS_MAX_FILTER_GROUPS,
  type RowFilter,
  type RowFilterOp,
} from "@datacanvas/database-core";
import { shapeOf } from "./filtering";

export interface ShapeCondition {
  column: string;
  op: RowFilterOp;
  group?: number;
}

export interface FilterShape {
  name: string;
  conditions: ShapeCondition[];
}

export const MAX_SHAPES_PER_TABLE = 20;
export const MAX_SHAPE_NAME_CHARS = 60;

export interface ShapeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const keyFor = (schema: string, table: string): string =>
  `datacanvas:filter-shapes:v1:${schema}.${table}`;

/** The shape of a set of filters: what stays when every value is taken away. */
export function shapeFromFilters(filters: readonly RowFilter[]): ShapeCondition[] {
  return filters.map((f) => ({
    column: f.column,
    op: f.op,
    ...(f.group !== undefined ? { group: f.group } : {}),
  }));
}

/** Does the condition need anything typed before it can be a filter? */
export const needsInput = (condition: ShapeCondition): boolean => shapeOf(condition.op) !== "none";

function isCondition(value: unknown): value is ShapeCondition {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.column === "string" &&
    c.column.length > 0 &&
    c.column.length <= 255 &&
    (ROW_FILTER_OPS as readonly unknown[]).includes(c.op) &&
    (c.group === undefined ||
      (Number.isInteger(c.group) &&
        (c.group as number) >= 1 &&
        (c.group as number) <= ROWS_MAX_FILTER_GROUPS))
  );
}

/** What is stored is untrusted (another tab, an older version, hand-editing): read only what is well formed. */
export function parseShapes(text: string | null): FilterShape[] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const shapes: FilterShape[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const { name, conditions } = item as { name?: unknown; conditions?: unknown };
    if (typeof name !== "string" || name === "" || name.length > MAX_SHAPE_NAME_CHARS) continue;
    if (!Array.isArray(conditions) || conditions.length === 0 || conditions.length > 10) continue;
    if (!conditions.every(isCondition)) continue;
    shapes.push({
      name,
      conditions: conditions.map((c) => ({
        column: c.column,
        op: c.op,
        ...(c.group !== undefined ? { group: c.group } : {}),
      })),
    });
    if (shapes.length >= MAX_SHAPES_PER_TABLE) break;
  }
  return shapes;
}

function browserStorage(): ShapeStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadShapes(
  schema: string,
  table: string,
  storage: ShapeStorage | null = browserStorage(),
): FilterShape[] {
  try {
    return parseShapes(storage?.getItem(keyFor(schema, table)) ?? null);
  } catch {
    return [];
  }
}

function write(
  schema: string,
  table: string,
  shapes: FilterShape[],
  storage: ShapeStorage | null,
): boolean {
  try {
    storage?.setItem(keyFor(schema, table), JSON.stringify(shapes));
    return storage !== null;
  } catch {
    return false;
  }
}

/** Save a shape under a name (replacing one of the same name). Returns the list now stored, or null when it could not be saved. */
export function saveShape(
  schema: string,
  table: string,
  name: string,
  filters: readonly RowFilter[],
  storage: ShapeStorage | null = browserStorage(),
): FilterShape[] | null {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > MAX_SHAPE_NAME_CHARS || filters.length === 0) return null;
  const others = loadShapes(schema, table, storage).filter((s) => s.name !== trimmed);
  if (others.length >= MAX_SHAPES_PER_TABLE) return null;
  const next = [...others, { name: trimmed, conditions: shapeFromFilters(filters) }];
  return write(schema, table, next, storage) ? next : null;
}

export function deleteShape(
  schema: string,
  table: string,
  name: string,
  storage: ShapeStorage | null = browserStorage(),
): FilterShape[] {
  const next = loadShapes(schema, table, storage).filter((s) => s.name !== name);
  write(schema, table, next, storage);
  return next;
}
