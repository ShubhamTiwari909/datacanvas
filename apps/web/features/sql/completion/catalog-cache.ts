/**
 * The catalog completion works from, one per connection, loaded once when the SQL view opens
 * and kept in memory (names and types only; never saved). It is read again after a change of
 * structure is applied, and dropped with the connection. A failed load is tried again on the
 * next request, but not more often than every few seconds.
 */
import { getLiveStructure } from "@/features/snapshots/api";
import { buildCatalog, type Catalog } from "./catalog";

interface Entry {
  catalog: Catalog | null;
  /** The load in progress, if any. */
  loading: Promise<Catalog | null> | null;
  /** When the last load failed, so a broken server is not asked again and again. */
  failedAt: number | null;
}

const entries = new Map<string, Entry>();
const RETRY_AFTER_MS = 5000;

/** The catalog of a connection: from memory, or loaded now. Resolves to null when it cannot be read. */
export function ensureCatalog(connectionId: string): Promise<Catalog | null> {
  const entry = entries.get(connectionId);
  if (entry?.catalog) return Promise.resolve(entry.catalog);
  if (entry?.loading) return entry.loading;
  if (
    entry?.failedAt !== null &&
    entry?.failedAt !== undefined &&
    Date.now() - entry.failedAt < RETRY_AFTER_MS
  ) {
    return Promise.resolve(null);
  }

  const next: Entry = { catalog: null, loading: null, failedAt: null };
  next.loading = getLiveStructure(connectionId).then((result) => {
    next.loading = null;
    // The connection may have been closed, or the entry replaced, while this was loading.
    if (entries.get(connectionId) !== next) return null;
    if (result.ok) {
      next.catalog = buildCatalog(result.data);
      return next.catalog;
    }
    next.failedAt = Date.now();
    return null;
  });
  entries.set(connectionId, next);
  return next.loading;
}

/** The catalog if it is already loaded (no request). */
export const peekCatalog = (connectionId: string): Catalog | null =>
  entries.get(connectionId)?.catalog ?? null;

/** The structure changed: the next request reads it again. */
export function invalidateCatalog(connectionId: string): void {
  entries.delete(connectionId);
}

/** The connection was closed. */
export const forgetCatalog = invalidateCatalog;
