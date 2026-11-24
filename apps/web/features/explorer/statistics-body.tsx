/**
 * What the server's statistics say about a table (`docs/insight-release-plan.md`, section 6; decision 165): sizes, the
 * rows and the upkeep, and for each column the share of NULLs, the distinct values, the width and the order. No row and
 * no value is read, so the figures are never blurred and need no switch. They are ESTIMATES from the last ANALYZE, and
 * the screen says so, and says why a column has no figures instead of showing zero.
 */
import type { TableStatistics } from "@datacanvas/database-core";
import { AlertTriangle } from "lucide-react";
import {
  deadRowsNote,
  distinctWords,
  formatBytes,
  formatShare,
  freshness,
  newest,
  orderWords,
  when,
} from "./statistics-format";

const count = (value: number | null): string =>
  value === null ? "unknown" : Math.round(value).toLocaleString("en-US");

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}

export function StatisticsBody({ stats }: { stats: TableStatistics }) {
  const fresh = freshness(stats);
  const dead = deadRowsNote(stats);
  const noFigures = stats.columns.filter((c) => !c.hasStatistics).length;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Estimates from the server&apos;s own statistics (the last ANALYZE). Nothing here reads a row
        of the table.
      </p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Rows (estimate)" value={count(stats.estimatedRows)} />
        <Fact label="Table size" value={formatBytes(stats.tableBytes)} />
        <Fact label="Index size" value={formatBytes(stats.indexBytes)} />
        <Fact label="TOAST size" value={formatBytes(stats.toastBytes)} />
        <Fact label="Live rows" value={count(stats.liveRows)} />
        <Fact label="Dead rows" value={count(stats.deadRows)} />
        <Fact label="Last analyzed" value={when(fresh.lastAnalyzed)} />
        <Fact label="Last vacuumed" value={when(newest(stats.lastVacuum, stats.lastAutovacuum))} />
      </dl>
      {stats.kind === "partitioned" ? (
        <p className="text-sm text-muted-foreground">
          A partitioned table holds no rows itself: its partitions do, and their own statistics have
          the figures that matter.
        </p>
      ) : null}
      {[fresh.note, dead]
        .filter((n): n is string => n !== null)
        .map((note) => (
          <p
            key={note}
            role="status"
            className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-sm"
          >
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
            {note}
          </p>
        ))}
      {noFigures > 0 && fresh.lastAnalyzed !== null ? (
        <p className="text-sm text-muted-foreground">
          {noFigures === 1 ? "One column has" : `${noFigures} columns have`} no figures: the
          connected role may not read {noFigures === 1 ? "it" : "them"}, or the server has not made
          any yet.
        </p>
      ) : null}
      <div
        className="overflow-x-auto rounded-lg border"
        tabIndex={0}
        aria-label="Statistics of the columns"
      >
        <table className="w-full min-w-[32rem] text-left text-sm">
          <caption className="sr-only">Statistics of the columns of the table</caption>
          <thead className="bg-muted text-xs text-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Column
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                NULL
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Distinct values
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Average width
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Order
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.columns.map((c) => (
              <tr key={c.column} className="border-t">
                <th scope="row" className="px-3 py-1.5 font-mono text-xs font-medium">
                  {c.column}
                </th>
                {c.hasStatistics ? (
                  <>
                    <td className="px-3 py-1.5">
                      {c.nullFraction === null ? "unknown" : formatShare(c.nullFraction)}
                    </td>
                    <td className="px-3 py-1.5">{distinctWords(c)}</td>
                    <td className="px-3 py-1.5">
                      {c.averageWidth === null ? "unknown" : `${count(c.averageWidth)} bytes`}
                    </td>
                    <td className="px-3 py-1.5">{orderWords(c.correlation)}</td>
                  </>
                ) : (
                  <td colSpan={4} className="px-3 py-1.5 text-muted-foreground">
                    No figures
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
