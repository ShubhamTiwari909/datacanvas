/**
 * Planned changes waiting to be applied (guardrail 5 of
 * `docs/data-editing-plan.md`: preview, then apply).
 *
 * `preview` puts the planned change here under an unguessable id; `apply`
 * takes ONLY that id and runs exactly what was planned. A preview:
 *  - lives in server memory only (it holds the person's values as statement
 *    parameters, so it is never written, logged or sent back),
 *  - belongs to one connection and cannot be applied through another,
 *  - expires after `PREVIEW_TTL_MS`, and is dropped then even if nobody touches
 *    the store again (a timer that exists only while something is held),
 *  - is single use: it is taken out of the store BEFORE it runs, so a
 *    repeated or concurrent apply cannot run it twice.
 */
import { PREVIEW_TTL_MS, type PlannedChange } from "@datacanvas/database-core";
import { randomBytes } from "node:crypto";

/** At most this many previews wait per connection; the oldest goes first. */
export const MAX_PREVIEWS_PER_CONNECTION = 20;

/**
 * At most this many IMPORT previews wait per connection. An import holds up to 100,000 rows (about 90 MB as a plan), and a
 * person has one import dialog open: a count of 20 alone could have held gigabytes.
 */
export const MAX_IMPORT_PREVIEWS_PER_CONNECTION = 2;

/** The changes that carry a whole file: an import, an update or insert, an update by key. They share the cap above. */
export const IMPORT_KINDS: ReadonlySet<string> = new Set([
  "insert_rows",
  "upsert_rows",
  "update_by_key",
]);

/**
 * At most this many previews of a change of the rows a filter matches wait per connection: each holds the keys of up
 * to 100,000 rows (up to about 16 MB), so a new one replaces the one before (`docs/write-side-v2-plan.md`, 6.6).
 */
export const MAX_MATCHING_PREVIEWS_PER_CONNECTION = 1;

/** The changes of the rows a filter matches: they share the cap above. */
export const MATCHING_KINDS: ReadonlySet<string> = new Set(["update_matching", "delete_matching"]);

interface Stored {
  connectionId: string;
  plan: PlannedChange;
  expiresAt: number;
}

/** How often expired previews are dropped while any are held. */
export const PREVIEW_SWEEP_INTERVAL_MS = 30_000;

export interface PreviewStoreOptions {
  now?: () => number;
  generateId?: () => string;
  ttlMs?: number;
  sweepIntervalMs?: number;
}

export class PreviewStore {
  // A Map keeps insertion order, which is the order "oldest first" needs.
  private readonly previews = new Map<string, Stored>();
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly ttlMs: number;
  private readonly sweepIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: PreviewStoreOptions = {}) {
    this.sweepIntervalMs = options.sweepIntervalMs ?? PREVIEW_SWEEP_INTERVAL_MS;
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
    if (IMPORT_KINDS.has(plan.change.kind)) {
      const imports = [...this.previews].filter(
        ([, stored]) =>
          stored.connectionId === connectionId && IMPORT_KINDS.has(stored.plan.change.kind),
      );
      for (const [id] of imports.slice(
        0,
        Math.max(0, imports.length - MAX_IMPORT_PREVIEWS_PER_CONNECTION + 1),
      )) {
        this.previews.delete(id);
      }
    }
    if (MATCHING_KINDS.has(plan.change.kind)) {
      const matching = [...this.previews].filter(
        ([, stored]) =>
          stored.connectionId === connectionId && MATCHING_KINDS.has(stored.plan.change.kind),
      );
      for (const [id] of matching.slice(
        0,
        Math.max(0, matching.length - MAX_MATCHING_PREVIEWS_PER_CONNECTION + 1),
      )) {
        this.previews.delete(id);
      }
    }
    const id = this.generateId();
    const expiresAt = this.now() + this.ttlMs;
    this.previews.set(id, { connectionId, plan, expiresAt });
    this.startTimer();
    return { id, expiresAt };
  }

  /**
   * Look at a preview without taking it (to check what the person typed before it is used up). Null when it does
   * not exist, has expired, or belongs to another connection; an expired one is dropped.
   */
  peek(connectionId: string, id: string): PlannedChange | null {
    const stored = this.previews.get(id);
    if (!stored || stored.connectionId !== connectionId) return null;
    if (stored.expiresAt <= this.now()) {
      this.previews.delete(id);
      return null;
    }
    return stored.plan;
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

  /** Stop the timer and forget every preview (shutdown). */
  dispose(): void {
    this.stopTimer();
    this.previews.clear();
  }

  /** How many previews are held at all, expired ones included (for tests). */
  heldCount(): number {
    return this.previews.size;
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

  /**
   * A plan holds the person's values, so how long it is retained must not
   * depend on the store being used again: while any is held, a timer drops the
   * expired ones. It stops itself when the store is empty and never keeps the
   * process alive.
   */
  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep();
      if (this.previews.size === 0) this.stopTimer();
    }, this.sweepIntervalMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
