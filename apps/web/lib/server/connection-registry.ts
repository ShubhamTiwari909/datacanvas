/**
 * In-memory registry of the connections the user has opened.
 *
 * WHAT IT HOLDS: for each connection, an opaque id, a password-free summary for
 * the browser, and the live `DatabaseAdapter` (which privately holds the
 * credentials). This is the ONLY place passwords exist after a connection is
 * created, and they live in memory only: they are never written to disk and are
 * gone when DataCanvas stops. `remove()` deletes them immediately.
 *
 * IDLE HANDLING: when a connection has not been used for a while its database
 * connections are closed (so we do not hold server resources for nothing), but
 * the entry and its credentials stay. The next request transparently reconnects.
 */
import type { DatabaseAdapter } from "@datacanvas/database-core";
import type { ConnectionSummary } from "@datacanvas/shared-types";
import { randomBytes } from "node:crypto";
import { ServiceError } from "./service-error";

export interface ConnectionRegistryOptions {
  /** How many connections may exist at once. Default 10. */
  maxConnections?: number;
  /** Close a connection's database sessions after this long unused. Default 30 minutes. */
  idleTimeoutMs?: number;
  /** Clock, injectable so tests do not have to wait. */
  now?: () => number;
  /** Id generator, injectable for tests. */
  generateId?: () => string;
}

interface Entry {
  summary: ConnectionSummary;
  adapter: DatabaseAdapter;
  lastUsedAt: number;
  /** Requests currently using the adapter; an entry with any is never closed as idle. */
  inFlight: number;
  /** True between a successful connect() and the idle close, so we only close what is open. */
  open: boolean;
}

export class ConnectionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly maxConnections: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(options: ConnectionRegistryOptions = {}) {
    this.maxConnections = options.maxConnections ?? 10;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60 * 1000;
    this.now = options.now ?? Date.now;
    // 16 random bytes = 128 bits, URL-safe: unguessable and safe to put in a URL.
    this.generateId = options.generateId ?? (() => randomBytes(16).toString("base64url"));
  }

  /**
   * Register an already-connected adapter and return its summary (with the new id).
   * @throws ServiceError `connection_limit_reached`
   */
  add(details: Omit<ConnectionSummary, "id">, adapter: DatabaseAdapter): ConnectionSummary {
    if (this.entries.size >= this.maxConnections) {
      throw new ServiceError(
        "connection_limit_reached",
        `You can have at most ${this.maxConnections} open connections. Disconnect one first.`,
      );
    }
    const summary: ConnectionSummary = { ...details, id: this.generateId() };
    this.entries.set(summary.id, {
      summary,
      adapter,
      lastUsedAt: this.now(),
      inFlight: 0,
      open: true,
    });
    return summary;
  }

  /** The summary of a connection, or undefined if it does not exist. */
  getSummary(id: string): ConnectionSummary | undefined {
    return this.entries.get(id)?.summary;
  }

  /**
   * Link a live connection to a saved profile (after "Save connection").
   * @throws ServiceError `connection_not_found`
   */
  setProfileId(id: string, profileId: string): ConnectionSummary {
    const entry = this.entries.get(id);
    if (!entry) throw new ServiceError("connection_not_found", "This connection does not exist.");
    entry.summary = { ...entry.summary, profileId };
    return entry.summary;
  }

  /**
   * Switch viewing table data on or off for a live connection.
   * @throws ServiceError `connection_not_found`
   */
  setDataAccess(id: string, enabled: boolean): ConnectionSummary {
    const entry = this.entries.get(id);
    if (!entry) throw new ServiceError("connection_not_found", "This connection does not exist.");
    entry.summary = { ...entry.summary, dataAccess: enabled };
    return entry.summary;
  }

  /** Detach every live connection from a profile that was forgotten. */
  clearProfile(profileId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.summary.profileId === profileId)
        entry.summary = { ...entry.summary, profileId: null };
    }
  }

  list(): ConnectionSummary[] {
    return [...this.entries.values()].map((entry) => entry.summary);
  }

  /**
   * Run `work` with the connection's adapter, reconnecting first if the idle
   * sweeper had closed it.
   * @throws ServiceError `connection_not_found`
   */
  async use<T>(id: string, work: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    const entry = this.entries.get(id);
    if (!entry) throw new ServiceError("connection_not_found", "This connection does not exist.");

    // Counted before any `await`, so the idle sweeper can never close the
    // adapter underneath a request that has already started.
    entry.inFlight += 1;
    try {
      await entry.adapter.connect(); // no-op when already connected
      entry.open = true;
      return await work(entry.adapter);
    } finally {
      entry.inFlight -= 1;
      entry.lastUsedAt = this.now();
    }
  }

  /**
   * Disconnect and forget a connection, discarding its credentials.
   * @throws ServiceError `connection_not_found`
   */
  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new ServiceError("connection_not_found", "This connection does not exist.");
    this.entries.delete(id); // forget first, so nothing can pick it up while we disconnect
    await entry.adapter.disconnect();
  }

  /** Close the database sessions of connections idle for too long. Returns how many were closed. */
  async closeIdle(): Promise<number> {
    const cutoff = this.now() - this.idleTimeoutMs;
    const idle = [...this.entries.values()].filter(
      (entry) => entry.open && entry.inFlight === 0 && entry.lastUsedAt <= cutoff,
    );
    for (const entry of idle) {
      entry.open = false;
      await entry.adapter.disconnect();
    }
    return idle.length;
  }

  /** Check for idle connections every `intervalMs`. Safe to call once; call `dispose()` to stop. */
  startIdleSweeper(intervalMs = 60_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      // A failure to close one idle connection must not become an unhandled rejection.
      void this.closeIdle().catch(() => {});
    }, intervalMs);
    // Do not let this timer keep the Node.js process alive on its own.
    this.sweeper.unref?.();
  }

  /** Stop the sweeper, disconnect everything and forget all credentials. */
  async dispose(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.adapter.disconnect().catch(() => {})));
  }
}
