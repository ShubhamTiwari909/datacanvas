/**
 * What the person can see and stop while Claude reads (`docs/mcp-server-plan.md`, sections 6 and 7; decision 169): the
 * activity list, the approvals that wait for a click, the pause, and a rate limit. Pure state with an injectable clock, in
 * MEMORY ONLY: nothing here is written anywhere, and nothing here holds a VALUE THAT WAS RETURNED. The list holds what Claude
 * ASKED (a statement, a table and its filters: the model's own request, shown to the person who allowed it) and counts of
 * what came back ("42 rows, 3.1 KB"), never the rows.
 */

export type Outcome =
  "waiting" | "ok" | "error" | "refused" | "not_approved" | "paused" | "rate_limited";

export interface ActivityEntry {
  id: string;
  /** ISO 8601. */
  at: string;
  tool: string;
  connection: string | null;
  connectionName: string | null;
  /** What Claude asked for, as words: the statement, or the table with its filters. */
  request: string;
  outcome: Outcome;
  /** Rows that were returned, when the tool returns rows. */
  rows?: number;
  /** Characters of the answer. */
  size?: number;
}

export interface PendingApproval {
  id: string;
  at: string;
  tool: string;
  connection: string;
  connectionName: string | null;
  request: string;
}

export type Decision = "approved" | "denied" | "timeout" | "aborted";

export interface ControlOptions {
  now?: () => number;
  /** How long an approval waits for a click. */
  approvalTimeoutMs?: number;
  /** How many calls the list keeps. */
  maxActivity?: number;
  /** How many calls a minute are served. */
  callsPerMinute?: number;
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 2 * 60 * 1000;
export const MAX_ACTIVITY = 200;
export const CALLS_PER_MINUTE = 30;
/** The most characters of a request: the longest statement (20,000) and room for the arguments of a page. */
export const REQUEST_CHARS = 25_000;

interface Waiter {
  entry: ActivityEntry;
  pending: PendingApproval;
  resolve: (decision: Decision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class McpControl {
  private readonly now: () => number;
  private readonly approvalTimeoutMs: number;
  private readonly maxActivity: number;
  private readonly callsPerMinute: number;
  private counter = 0;
  private readonly entries: ActivityEntry[] = [];
  private readonly waiters = new Map<string, Waiter>();
  private readonly calls: number[] = [];
  paused = false;

  constructor(options: ControlOptions = {}) {
    this.now = options.now ?? Date.now;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.maxActivity = options.maxActivity ?? MAX_ACTIVITY;
    this.callsPerMinute = options.callsPerMinute ?? CALLS_PER_MINUTE;
  }

  private nextId(): string {
    this.counter += 1;
    return `c${this.counter}`;
  }

  /** Record that Claude asked for something. */
  begin(input: Omit<ActivityEntry, "id" | "at" | "outcome">): ActivityEntry {
    const entry: ActivityEntry = {
      ...input,
      request: input.request.slice(0, REQUEST_CHARS),
      id: this.nextId(),
      at: new Date(this.now()).toISOString(),
      outcome: "waiting",
    };
    this.entries.push(entry);
    while (this.entries.length > this.maxActivity) this.entries.shift();
    return entry;
  }

  /** Say how it ended (once: a call that already ended keeps its outcome). */
  finish(
    entry: ActivityEntry,
    outcome: Exclude<Outcome, "waiting">,
    details: { rows?: number; size?: number } = {},
  ): void {
    if (entry.outcome !== "waiting") return;
    entry.outcome = outcome;
    if (details.rows !== undefined) entry.rows = details.rows;
    if (details.size !== undefined) entry.size = details.size;
  }

  /** A call is served only up to a number a minute: true when this one may go on (and it is counted). */
  allowCall(): boolean {
    const at = this.now();
    while (this.calls.length > 0 && at - this.calls[0]! >= 60_000) this.calls.shift();
    if (this.calls.length >= this.callsPerMinute) return false;
    this.calls.push(at);
    return true;
  }

  /** Wait for the person to approve this call: resolves with their answer, or "timeout", or "aborted" (the client gave up). */
  requestApproval(
    entry: ActivityEntry,
    connection: string,
    connectionName: string | null,
    signal?: {
      aborted: boolean;
      addEventListener?: (type: "abort", listener: () => void, options?: { once: boolean }) => void;
    },
  ): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      const pending: PendingApproval = {
        id: entry.id,
        at: entry.at,
        tool: entry.tool,
        connection,
        connectionName,
        request: entry.request,
      };
      const done = (decision: Decision): void => {
        const waiter = this.waiters.get(entry.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.waiters.delete(entry.id);
        waiter.resolve(decision);
      };
      const timer = setTimeout(() => done("timeout"), this.approvalTimeoutMs);
      timer.unref?.();
      this.waiters.set(entry.id, { entry, pending, resolve, timer });
      if (signal?.aborted) done("aborted");
      else signal?.addEventListener?.("abort", () => done("aborted"), { once: true });
    });
  }

  /** The person's answer to a waiting approval. False when there is none by that id (it was answered, or timed out). */
  decide(id: string, decision: "approve" | "deny"): boolean {
    const waiter = this.waiters.get(id);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.waiters.delete(id);
    waiter.resolve(decision === "approve" ? "approved" : "denied");
    return true;
  }

  pending(): PendingApproval[] {
    return [...this.waiters.values()].map((w) => ({ ...w.pending }));
  }

  /** Newest first. */
  activity(): ActivityEntry[] {
    return [...this.entries].reverse().map((e) => ({ ...e }));
  }

  /** Answer every waiting approval with a denial (sharing ended, or paused): nothing waits for ever. */
  denyAll(connection?: string): void {
    for (const [id, waiter] of [...this.waiters]) {
      if (connection === undefined || waiter.pending.connection === connection)
        this.decide(id, "deny");
    }
  }

  /** Forget everything (nothing is shared any more): the list, the pause and the count of calls. */
  reset(): void {
    this.denyAll();
    this.entries.length = 0;
    this.calls.length = 0;
    this.paused = false;
  }
}
