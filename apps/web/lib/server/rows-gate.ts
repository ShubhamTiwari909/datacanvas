/**
 * Reads of table rows go through this, one connection at a time.
 *
 * A row read can be slow (a big table, a view), and the browser can ask again
 * before the last answer arrived (paging quickly, switching tables). Running them
 * all at once would crowd the connection pool; so each connection reads one page
 * at a time, a few more may wait their turn, and past that the request is refused
 * with `rows_busy` instead of queueing without limit.
 */
import { ServiceError } from "./service-error";

/** At most this many reads wait behind the one that is running. */
export const MAX_WAITING_ROW_READS = 3;

export class RowsGate {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly counts = new Map<string, number>();

  /** Run `work` after the earlier reads of the same connection. @throws ServiceError `rows_busy` */
  async run<T>(connectionId: string, work: () => Promise<T>): Promise<T> {
    const count = this.counts.get(connectionId) ?? 0;
    // One running plus `MAX_WAITING_ROW_READS` waiting.
    if (count > MAX_WAITING_ROW_READS) {
      throw new ServiceError(
        "rows_busy",
        "Too many table reads are waiting on this connection. Wait a moment and try again.",
      );
    }
    this.counts.set(connectionId, count + 1);
    const previous = this.tails.get(connectionId) ?? Promise.resolve();
    // A failed earlier read must not block the queue, so its rejection is ignored here.
    const current = previous.catch(() => {}).then(work);
    this.tails.set(connectionId, current);
    try {
      return await current;
    } finally {
      const left = (this.counts.get(connectionId) ?? 1) - 1;
      if (left <= 0) {
        this.counts.delete(connectionId);
        if (this.tails.get(connectionId) === current) this.tails.delete(connectionId);
      } else {
        this.counts.set(connectionId, left);
      }
    }
  }

  /** Forget a connection that was closed. */
  forget(connectionId: string): void {
    this.counts.delete(connectionId);
    this.tails.delete(connectionId);
  }
}
