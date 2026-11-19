/**
 * Compare two sides, each either a saved snapshot or the live database of a
 * connection (any connection, so two different databases can be compared).
 *
 * The comparison itself is the pure `diffStructures`; this file only fetches
 * both structures and names them for display. Structure only: this feature reads no table rows.
 */
import { diffStructures, type DatabaseStructure, type SchemaDiff } from "@datacanvas/database-core";
import type { ApiResult } from "@/lib/api-client";
import { getLiveStructure, getSnapshot } from "./api";

export type CompareSide =
  | { kind: "snapshot"; id: string; label: string }
  | { kind: "live"; connectionId: string; label: string };

export interface Comparison {
  diff: SchemaDiff;
  before: string;
  after: string;
}

export async function loadSide(side: CompareSide): Promise<ApiResult<DatabaseStructure>> {
  if (side.kind === "live") return getLiveStructure(side.connectionId);
  const snapshot = await getSnapshot(side.id);
  return snapshot.ok ? { ok: true, data: snapshot.data.structure } : snapshot;
}

/** Fetch both structures (in parallel) and diff them. The first failure is returned as is. */
export async function compareSides(
  before: CompareSide,
  after: CompareSide,
): Promise<ApiResult<Comparison>> {
  const [a, b] = await Promise.all([loadSide(before), loadSide(after)]);
  if (!a.ok) return a;
  if (!b.ok) return b;
  return {
    ok: true,
    data: { diff: diffStructures(a.data, b.data), before: before.label, after: after.label },
  };
}

/** "snapshot:<id>" / "live:<connectionId>": the value of a select option. */
export const sideValue = (side: CompareSide): string =>
  side.kind === "snapshot" ? `snapshot:${side.id}` : `live:${side.connectionId}`;
