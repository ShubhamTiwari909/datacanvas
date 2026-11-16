/**
 * Planned changes waiting to be applied (guardrail 5 of
 * `docs/data-editing-plan.md`: preview, then apply).
 *
 * `preview` puts the planned change here under an unguessable id; `apply`
 * takes ONLY that id and runs exactly what was planned. A preview:
 *  - lives in server memory only (it holds the person's values as statement
 *    parameters, so it is never written, logged or sent back),
 *  - belongs to one connection and cannot be applied through another,
 *  - expires after `PREVIEW_TTL_MS`,
 *  - is single use: it is taken out of the store BEFORE it runs, so a
 *    repeated or concurrent apply cannot run it twice.
 */
import { PREVIEW_TTL_MS, type PlannedChange } from "@datacanvas/database-core";
import { randomBytes } from "node:crypto";

/** At most this many previews wait per connection; the oldest goes first. */
export const MAX_PREVIEWS_PER_CONNECTION = 20;

interface Stored {
  connectionId: string;
  plan: PlannedChange;
  expiresAt: number;
}

export interface PreviewStoreOptions {
  now?: () => number;
  generateId?: () => string;
  ttlMs?: number;
}

export class PreviewStore {
  // A Map keeps insertion order, which is the order "oldest first" needs.
  private readonly previews = new Map<string, Stored>();
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly ttlMs: number;

  constructor(options: PreviewStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    // 16 random bytes = 128 bits, URL-safe.
    this.generateId = options.generateId ?? (() => randomBytes(16).toString("base64url"));
    this.ttlMs = options.ttlMs ?? PREVIEW_TTL_MS;
  }

  /** Keep a planned change for a connection; returns its id and when it expires (epoch ms). */
  put(connectionId: string, plan: PlannedChange): { id: string; expiresAt: number } {
    this.sweep();
    const mine = [...this.previews].filter(([, stored]) => stored.connectionId === connectionId);
    for (const [id] of mine.slice(0, Math.max(0, mine.length - MAX_PREVIEWS_PER_CONNECTION + 1))) {
      this.previews.delete(id);
    }
    const id = this.generateId();
    const expiresAt = this.now() + this.ttlMs;
    this.previews.set(id, { connectionId, plan, expiresAt });
    return { id, expiresAt };
  }

  /**
   * Take a preview out of the store (single use). Null when it does not exist,
   * has expired, or belongs to another connection; in the last case it stays
   * where it is, so a wrong connection id cannot destroy someone's preview.
   */
  take(connectionId: string, id: string): PlannedChange | null {
    const stored = this.previews.get(id);
    if (!stored || stored.connectionId !== connectionId) return null;
    this.previews.delete(id);
    return stored.expiresAt > this.now() ? stored.plan : null;
  }

  /** Forget every preview of one connection (lock, disconnect, data viewing switched off). */
  clear(connectionId: string): void {
    for (const [id, stored] of this.previews) {
      if (stored.connectionId === connectionId) this.previews.delete(id);
    }
  }

  /** How many previews are kept for a connection (for tests). */
  count(connectionId: string): number {
    this.sweep();
    return [...this.previews.values()].filter((s) => s.connectionId === connectionId).length;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, stored] of this.previews) {
      if (stored.expiresAt <= now) this.previews.delete(id);
    }
  }
}
