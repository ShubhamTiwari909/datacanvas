/**
 * A browser-side CACHE of database STRUCTURE (tables, columns, relationships).
 *
 * Kept apart from the canvas store on purpose:
 *   - metadata = what the database looks like (comes from the server, can be
 *     re-fetched at any time, belongs to a connection);
 *   - canvas   = what the USER arranged (which tables are shown, where, expanded
 *     or not; this is what a saved workspace will contain).
 * A table node stores only its identity; it reads its columns from here.
 *
 * The cache is never refreshed automatically: if the database changes while
 * DataCanvas is open, reconnecting shows the new structure.
 */
import { MAX_TABLES_PER_DETAILS_REQUEST } from "@datacanvas/shared-types";
import {
  tableRefKey,
  type RelationshipInfo,
  type TableDetailsEntry,
  type TableRef,
} from "@datacanvas/database-core";
import { create } from "zustand";
import { getRelationships, getTablesDetails } from "@/features/explorer/api";

export interface ConnectionMetadata {
  /** Keyed by `tableRefKey` (which is also the canvas node id). */
  tables: Record<string, TableDetailsEntry>;
  /** null until loaded. */
  relationships: RelationshipInfo[] | null;
}

type Outcome = { ok: true } | { ok: false; message: string };

interface MetadataState {
  byConnection: Record<string, ConnectionMetadata | undefined>;
  /** Load the details of any of these tables that are not cached yet. */
  ensureTables: (connectionId: string, refs: TableRef[]) => Promise<Outcome>;
  /** Load the relationships of the whole database, once. */
  ensureRelationships: (connectionId: string) => Promise<Outcome>;
  /**
   * After a change of structure made from DataCanvas (1.4.0): forget the tables
   * that no longer exist, read again the cached tables that changed, and read
   * the relationships again if they were loaded. The fresh copies replace the
   * old ones only when they arrive, so the canvas never shows a gap.
   */
  refreshAfterChange: (
    connectionId: string,
    changes: { reload: TableRef[]; drop: TableRef[] },
  ) => Promise<Outcome>;
  forgetConnection: (connectionId: string) => void;
}

const empty = (): ConnectionMetadata => ({ tables: {}, relationships: null });

export const useMetadataStore = create<MetadataState>((set, get) => ({
  byConnection: {},

  async ensureTables(connectionId, refs) {
    const cached = get().byConnection[connectionId]?.tables ?? {};
    const missing = refs.filter((ref) => !(tableRefKey(ref) in cached));

    // The server accepts a limited number of tables per request, so ask in chunks.
    for (let start = 0; start < missing.length; start += MAX_TABLES_PER_DETAILS_REQUEST) {
      const chunk = missing.slice(start, start + MAX_TABLES_PER_DETAILS_REQUEST);
      const result = await getTablesDetails(connectionId, chunk);
      if (!result.ok) return { ok: false, message: result.error.message };

      set((state) => {
        const current = state.byConnection[connectionId] ?? empty();
        const tables = { ...current.tables };
        for (const entry of result.data) {
          tables[tableRefKey({ schema: entry.table.schema, name: entry.table.name })] = entry;
        }
        return { byConnection: { ...state.byConnection, [connectionId]: { ...current, tables } } };
      });
    }
    return { ok: true };
  },

  async ensureRelationships(connectionId) {
    if (get().byConnection[connectionId]?.relationships) return { ok: true };
    const result = await getRelationships(connectionId);
    if (!result.ok) return { ok: false, message: result.error.message };
    set((state) => {
      const current = state.byConnection[connectionId] ?? empty();
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: { ...current, relationships: result.data },
        },
      };
    });
    return { ok: true };
  },

  async refreshAfterChange(connectionId, { reload, drop }) {
    const before = get().byConnection[connectionId];
    if (!before) return { ok: true };
    const dropped = new Set(drop.map(tableRefKey));
    const cachedReload = reload.filter((ref) => tableRefKey(ref) in before.tables);
    const relationshipsWereLoaded = before.relationships !== null;

    const [details, relationships] = await Promise.all([
      cachedReload.length > 0
        ? getTablesDetails(connectionId, cachedReload.slice(0, MAX_TABLES_PER_DETAILS_REQUEST))
        : Promise.resolve(null),
      relationshipsWereLoaded ? getRelationships(connectionId) : Promise.resolve(null),
    ]);

    set((state) => {
      const current = state.byConnection[connectionId];
      if (!current) return state;
      const tables = { ...current.tables };
      for (const key of dropped) delete tables[key];
      if (details?.ok) {
        for (const entry of details.data) {
          tables[tableRefKey({ schema: entry.table.schema, name: entry.table.name })] = entry;
        }
      }
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            tables,
            relationships: relationships?.ok ? relationships.data : current.relationships,
          },
        },
      };
    });
    if (details && !details.ok) return { ok: false, message: details.error.message };
    if (relationships && !relationships.ok)
      return { ok: false, message: relationships.error.message };
    return { ok: true };
  },

  forgetConnection(connectionId) {
    set((state) => {
      const rest = { ...state.byConnection };
      delete rest[connectionId];
      return { byConnection: rest };
    });
  },
}));
