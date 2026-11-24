/**
 * The words for the statistics of a table (`docs/insight-release-plan.md`, section 6): sizes, shares, and what the
 * figures say about how fresh they are. Pure functions, no React. Everything shown is an ESTIMATE from the last
 * ANALYZE, and the words say so.
 */
import type { ColumnStatistics, TableStatistics } from "@datacanvas/database-core";

const number = (value: number, digits = 0): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: digits });

/** 8192 -> "8 KB", 5_300_000 -> "5.1 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${number(bytes)} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${number(value, value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** 0.5 -> "50%", 0.004 -> "0.4%", 0 -> "0%". */
export function formatShare(fraction: number): string {
  const percent = fraction * 100;
  if (percent === 0) return "0%";
  if (percent < 1) return `${number(percent, 1)}%`;
  return `${number(percent, percent < 10 ? 1 : 0)}%`;
}

/** "10 distinct", "all different", "about 40% of the rows are different", or "unknown". */
export function distinctWords(c: ColumnStatistics): string {
  if (c.distinctValues !== null) return `${number(c.distinctValues)} distinct`;
  if (c.distinctShare !== null) {
    return c.distinctShare >= 0.999
      ? "all different"
      : `${formatShare(c.distinctShare)} of the rows differ`;
  }
  return "unknown";
}

/** How well the values follow the order of the rows on disk: a clustered column makes range reads cheap. */
export function orderWords(correlation: number | null): string {
  if (correlation === null) return "unknown";
  const size = Math.abs(correlation);
  if (size >= 0.9) return correlation > 0 ? "in order" : "in reverse order";
  if (size >= 0.4) return "partly in order";
  return "no order";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The latest of several times (ISO 8601 text sorts as time), or null when none happened. */
export function newest(...times: Array<string | null>): string | null {
  const known = times.filter((t): t is string => t !== null);
  return known.length === 0 ? null : known.reduce((a, b) => (a > b ? a : b));
}

export interface Freshness {
  /** The time of the last analyze, by hand or automatic. */
  lastAnalyzed: string | null;
  /** Said in words when the figures deserve a caution; null when they are recent. */
  note: string | null;
}

/** When the figures were made, and a caution when they were never made or are old. */
export function freshness(stats: TableStatistics, now: Date = new Date()): Freshness {
  const lastAnalyzed = newest(stats.lastAnalyze, stats.lastAutoanalyze);
  if (lastAnalyzed === null) {
    return {
      lastAnalyzed,
      note: "This table has never been analysed, so there are no figures for its columns and the planner is guessing.",
    };
  }
  const days = Math.floor((now.getTime() - new Date(lastAnalyzed).getTime()) / DAY_MS);
  return {
    lastAnalyzed,
    note: days >= 30 ? `The figures are ${number(days)} days old. ANALYZE makes them again.` : null,
  };
}

/** A caution when a fifth of the rows or more are dead (deleted or replaced, not yet cleaned up). */
export function deadRowsNote(stats: TableStatistics): string | null {
  const dead = stats.deadRows;
  const live = stats.liveRows;
  if (dead === null || live === null || dead < 1000) return null;
  return dead / Math.max(1, dead + live) >= 0.2
    ? `${number(dead)} dead rows (${formatShare(dead / (dead + live))} of the table): a vacuum may be due.`
    : null;
}

export function when(time: string | null): string {
  if (time === null) return "never";
  return new Date(time).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
