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
 * The cache is not refreshed on its own: if the database changes while
 * DataCanvas is open, reconnecting shows the new structure. The one exception
 * is a change made from DataCanvas itself (1.4.0), which calls
 * `refreshAfterChange`.
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
  /**
   * Cached tables whose refresh after a change failed. They are still shown (the old copy is better
   * than a gap) but `ensureTables` reads them again, so a transient failure heals itself.
   */
  staleTables?: Record<string, true>;
  /** The refresh of the relationships after a change failed: `ensureRelationships` reads them again. */
  relationshipsStale?: boolean;
}

type Outcome = { ok: true } | { ok: false; message: string };

interface MetadataState {
  byConnection: Record<string, ConnectionMetadata | undefined>;
  /** Load the details of any of these tables that are not cached yet (or whose refresh failed). */
  ensureTables: (connectionId: string, refs: TableRef[]) => Promise<Outcome>;
  /** Load the relationships of the whole database, once (again if their refresh failed). */
  ensureRelationships: (connectionId: string) => Promise<Outcome>;
  /**
   * After a change of structure made from DataCanvas (1.4.0): forget the tables
   * that no longer exist, read again the cached tables that changed, and read
   * the relationships again if they were loaded. The fresh copies replace the
   * old ones only when they arrive, so the canvas never shows a gap, and only
   * if no newer read of the same table has started since (back-to-back changes
   * can finish out of order). A read that fails marks its tables stale, so the
   * next `ensureTables` or `ensureRelationships` tries again.
   */
  refreshAfterChange: (
    connectionId: string,
    changes: { reload: TableRef[]; drop: TableRef[] },
  ) => Promise<Outcome>;
  forgetConnection: (connectionId: string) => void;
}

const empty = (): ConnectionMetadata => ({ tables: {}, relationships: null });

/**
 * Which read of a table (or of the relationships) is the newest. Every call that
 * can replace a cache entry takes a stamp from `clock` when it starts; a refresh
 * also claims the entries it is about to replace. An answer is applied only if no
 * LATER refresh has claimed the same entry in the meantime, so an older answer
 * can never overwrite a newer one, whatever order they arrive in. Entries of
 * different tables are independent: a slow refresh of one table does not hold
 * back the answer for another.
 */
let clock = 0;
const claimed = new Map<string, number>();
const claimKey = (connectionId: string, entry: string) => `${connectionId}\u0000${entry}`;
const RELATIONSHIPS = "\u0000relationships";

const superseded = (connectionId: string, entry: string, stamp: number): boolean =>
  (claimed.get(claimKey(connectionId, entry)) ?? 0) > stamp;

export const useMetadataStore = create<MetadataState>((set, get) => ({
  byConnection: {},

  async ensureTables(connectionId, refs) {
    const current = get().byConnection[connectionId];
    const cached = current?.tables ?? {};
    const stale = current?.staleTables ?? {};
    const missing = refs.filter((ref) => {
      const key = tableRefKey(ref);
      return !(key in cached) || key in stale;
    });
    const stamp = ++clock;

    // The server accepts a limited number of tables per request, so ask in chunks.
    for (let start = 0; start < missing.length; start += MAX_TABLES_PER_DETAILS_REQUEST) {
      const chunk = missing.slice(start, start + MAX_TABLES_PER_DETAILS_REQUEST);
      const result = await getTablesDetails(connectionId, chunk);
      if (!result.ok) return { ok: false, message: result.error.message };

      set((state) => {
        const metadata = state.byConnection[connectionId] ?? empty();
        const tables = { ...metadata.tables };
        const staleTables = { ...metadata.staleTables };
        for (const entry of result.data) {
          const key = tableRefKey({ schema: entry.table.schema, name: entry.table.name });
          // A change made after this read began has its own, newer answer for this table.
          if (superseded(connectionId, key, stamp)) continue;
          tables[key] = entry;
          delete staleTables[key];
        }
        return {
          byConnection: {
            ...state.byConnection,
            [connectionId]: { ...metadata, tables, staleTables },
          },
        };
      });
    }
    return { ok: true };
  },

  async ensureRelationships(connectionId) {
    const current = get().byConnection[connectionId];
    if (current?.relationships && !current.relationshipsStale) return { ok: true };
    const stamp = ++clock;
    const result = await getRelationships(connectionId);
    if (!result.ok) return { ok: false, message: result.error.message };
    if (superseded(connectionId, RELATIONSHIPS, stamp)) return { ok: true };
    set((state) => {
      const metadata = state.byConnection[connectionId] ?? empty();
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: { ...metadata, relationships: result.data, relationshipsStale: false },
        },
      };
    });
    return { ok: true };
  },

  async refreshAfterChange(connectionId, { reload, drop }) {
    const stamp = ++clock;
    const dropped = drop.map(tableRefKey);
    // Claimed even when nothing is cached yet: a read of the table that is still on its way
    // must not bring a dropped table back.
    for (const key of dropped) claimed.set(claimKey(connectionId, key), stamp);
    const before = get().byConnection[connectionId];
    if (!before) return { ok: true };
    const cachedReload = reload.filter((ref) => tableRefKey(ref) in before.tables);
    const relationshipsWereLoaded = before.relationships !== null;

    // Claim what this refresh will replace, so an older answer cannot land on top of it.
    for (const ref of cachedReload) claimed.set(claimKey(connectionId, tableRefKey(ref)), stamp);
    if (relationshipsWereLoaded) claimed.set(claimKey(connectionId, RELATIONSHIPS), stamp);

    const chunks: TableRef[][] = [];
    for (let start = 0; start < cachedReload.length; start += MAX_TABLES_PER_DETAILS_REQUEST) {
      chunks.push(cachedReload.slice(start, start + MAX_TABLES_PER_DETAILS_REQUEST));
    }
    const [details, relationships] = await Promise.all([
      Promise.all(chunks.map((chunk) => getTablesDetails(connectionId, chunk))),
      relationshipsWereLoaded ? getRelationships(connectionId) : Promise.resolve(null),
    ]);

    // Still ours to apply? (A newer refresh of the same table may have claimed it while this one ran.)
    const ours = (entry: string) => claimed.get(claimKey(connectionId, entry)) === stamp;

    set((state) => {
      const current = state.byConnection[connectionId];
      if (!current) return state;
      const tables = { ...current.tables };
      const staleTables = { ...current.staleTables };
      for (const key of dropped) {
        if (!ours(key)) continue;
        delete tables[key];
        delete staleTables[key];
      }
      chunks.forEach((chunk, index) => {
        const result = details[index];
        if (result?.ok) {
          for (const entry of result.data) {
            const key = tableRefKey({ schema: entry.table.schema, name: entry.table.name });
            if (!ours(key)) continue;
            tables[key] = entry;
            delete staleTables[key];
          }
        } else {
          // Keep showing the old copy, but let the next ensure read it again.
          for (const ref of chunk) {
            const key = tableRefKey(ref);
            if (ours(key) && key in tables) staleTables[key] = true;
          }
        }
      });
      let next: Pick<ConnectionMetadata, "relationships" | "relationshipsStale"> = {
        relationships: current.relationships,
        relationshipsStale: current.relationshipsStale,
      };
      if (relationships && ours(RELATIONSHIPS)) {
        next = relationships.ok
          ? { relationships: relationships.data, relationshipsStale: false }
          : { relationships: current.relationships, relationshipsStale: true };
      }
      return {
        byConnection: { ...state.byConnection, [connectionId]: { tables, staleTables, ...next } },
      };
    });

    const failed = details.find((result) => !result.ok);
    if (failed && !failed.ok) return { ok: false, message: failed.error.message };
    if (relationships && !relationships.ok)
      return { ok: false, message: relationships.error.message };
    return { ok: true };
  },

  forgetConnection(connectionId) {
    const prefix = claimKey(connectionId, "");
    for (const key of claimed.keys()) if (key.startsWith(prefix)) claimed.delete(key);
    set((state) => {
      const rest = { ...state.byConnection };
      delete rest[connectionId];
      return { byConnection: rest };
    });
  },
}));
