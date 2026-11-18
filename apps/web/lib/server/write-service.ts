/**
 * Editing rows and designing tables (1.4.0, `docs/data-editing-plan.md`): the
 * ONLY place in the app that reaches an adapter's write capability
 * (`WritableAdapter`). A rule in tests/architecture.test.ts fails if any other
 * app file does.
 *
 * Every write needs all of these, checked on every call, in this order:
 *   1. the process was started with `--enable-writes` (not reachable from the API),
 *   2. the connection's host is this machine (`localhost`, `127.0.0.0/8` or `::1`),
 *   3. viewing table data is on for the connection,
 *   4. the person unlocked writes for it in this session, by typing its
 *      database name (memory only; cleared by disconnecting, by switching data
 *      viewing off and by a restart).
 *
 * A change is previewed first: the adapter plans it in a read-only
 * transaction, the plan (with the person's values as statement parameters)
 * stays in server memory under a single-use id, and the browser gets the
 * statement text, the effect and the warnings, never the parameters. Apply
 * takes only that id and runs exactly the plan, one change at a time per
 * connection.
 *
 * PRIVACY: values of a change are never logged, stored in the history, put in
 * an error or sent back. The history holds the kind of change, the table, the
 * column names, the time, the outcome and, for a change of structure only
 * (and not one that carries a literal default or a comment), its SQL. Nothing here writes to a log: a rule in tests/security.test.ts
 * fails if any file of the write path does.
 */
import {
  changeCarriesUserText,
  changeColumns,
  changeTable,
  DatabaseError,
  isDatabaseError,
  isWritableAdapter,
  statementText,
  type Change,
  type DatabaseAdapter,
  type PlannedChange,
  type TableEditInfo,
  type TableRef,
  type WritableAdapter,
} from "@datacanvas/database-core";
import type { ChangePreview, HistoryEntry, WritesStatus } from "@datacanvas/shared-types";
import { randomBytes } from "node:crypto";
import { isLocalHost, type ConnectionRegistry } from "./connection-registry";
import { PreviewStore } from "./preview-store";
import { ServiceError } from "./service-error";

/** At most this many history lines are kept per connection; the oldest go first. */
export const MAX_HISTORY_PER_CONNECTION = 200;

export const WRITE_MESSAGES = {
  connectionNotFound: "This connection does not exist.",
  notEnabled:
    "Writes are not enabled. Start DataCanvas with --enable-writes to edit rows and tables on a local database.",
  notLocal:
    "Writes are only available on a database running on this machine. This connection stays read-only.",
  dataAccessOff:
    "Editing needs viewing table data to be on for this connection. Switch it on first.",
  wrongName: "That is not the name of this connection's database. Writes stay locked.",
  notUnlocked: "Writes are locked for this connection. Unlock them by typing the database name.",
  previewExpired: "This preview has expired or was already used. Preview the change again.",
  busy: "Another change is running on this connection. Wait for it to finish, then try again.",
  confirmName: "Type the table's name to confirm.",
  notWritable: "This database cannot be changed from DataCanvas.",
} as const;

export interface WriteServiceDependencies {
  connections: ConnectionRegistry;
  /** `SecurityConfig.writesEnabled`: DataCanvas was started with `--enable-writes`. */
  writesEnabled: boolean;
  previews?: PreviewStore;
  now?: () => number;
  generateId?: () => string;
}

export class WriteService {
  private readonly connections: ConnectionRegistry;
  private readonly writesEnabled: boolean;
  private readonly previews: PreviewStore;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly histories = new Map<string, HistoryEntry[]>();
  /** Connections with a change running right now (one at a time per connection). */
  private readonly busy = new Set<string>();

  constructor(dependencies: WriteServiceDependencies) {
    this.connections = dependencies.connections;
    this.writesEnabled = dependencies.writesEnabled;
    this.previews = dependencies.previews ?? new PreviewStore({ now: dependencies.now });
    this.now = dependencies.now ?? Date.now;
    this.generateId = dependencies.generateId ?? (() => randomBytes(12).toString("base64url"));
    // A disconnect (or shutdown) forgets everything that belonged to the connection.
    this.connections.onRemove((id) => this.forget(id));
    // Locking writes, or switching data viewing off (which locks them), drops the
    // plans made while they were unlocked: they hold the person's values.
    this.connections.onWriteLocked((id) => this.previews.clear(id));
  }

  /** Whether writes are possible on a connection, and which of the switches are off. */
  status(id: string): WritesStatus {
    const summary = this.summary(id);
    return {
      enabled: this.writesEnabled,
      local: isLocalHost(summary.host),
      dataAccess: summary.dataAccess,
      unlocked: this.connections.isWriteUnlocked(id),
    };
  }

  /**
   * Unlock writes for one connection by typing its database name. Previews made
   * before are dropped, so each unlock starts clean.
   * @throws ServiceError `connection_not_found`, `writes_not_enabled`,
   *   `writes_not_allowed_here`, `data_access_disabled`, `wrong_database_name`
   */
  unlock(id: string, database: string): WritesStatus {
    const summary = this.summary(id);
    this.requireSwitches(summary);
    // Exact match. The refusal never repeats what was typed.
    if (database !== summary.database) {
      throw new ServiceError("wrong_database_name", WRITE_MESSAGES.wrongName);
    }
    this.connections.setWriteUnlocked(id, true);
    this.previews.clear(id);
    return this.status(id);
  }

  /** Lock writes again and drop the connection's previews. Works whatever the switches say. */
  lock(id: string): WritesStatus {
    this.summary(id);
    this.connections.setWriteUnlocked(id, false);
    this.previews.clear(id);
    return this.status(id);
  }

  /** What the row editor needs about a table. Needs writes unlocked. */
  editInfo(id: string, table: TableRef): Promise<TableEditInfo> {
    return this.withWritable(id, (adapter) => adapter.describeForEdit(table));
  }

  /**
   * Plan a change (nothing is changed) and keep the plan for `apply`. The
   * answer carries the statement text, never its parameters.
   */
  async preview(id: string, change: Change): Promise<ChangePreview> {
    checkConfirmation(change);
    const plan = await this.withWritable(id, (adapter) => adapter.previewChange(change));
    // The connection may have been locked or closed while the plan was made.
    this.requireUnlocked(id);
    const { id: previewId, expiresAt } = this.previews.put(id, plan);
    return {
      previewId,
      statement: statementText(plan),
      effect: plan.effect,
      warnings: plan.warnings.map((w) => ({ code: w.code, message: w.message })),
      destructive: plan.destructive,
      category: plan.category,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * Run a previewed change exactly as planned. The preview is used up whether
   * it succeeds or fails; the outcome goes into the history.
   * @throws ServiceError `preview_expired`, `write_busy` and the switch errors;
   *   DatabaseError from the adapter (fixed messages only).
   */
  async apply(id: string, previewId: string): Promise<{ rowCount: number; entry: HistoryEntry }> {
    this.requireUnlocked(id);
    // Checked BEFORE taking the preview, so a busy connection does not use it up.
    if (this.busy.has(id)) throw new ServiceError("write_busy", WRITE_MESSAGES.busy);
    const plan = this.previews.take(id, previewId);
    if (!plan) throw new ServiceError("preview_expired", WRITE_MESSAGES.previewExpired);

    this.busy.add(id);
    try {
      const applied = await this.connections.use(id, (adapter) => {
        // `use` may have waited to reconnect: writes can have been locked meanwhile.
        this.requireUnlocked(id);
        return writable(adapter).applyChange(plan);
      });
      return { rowCount: applied.rowCount, entry: this.record(id, plan, null) };
    } catch (error) {
      this.record(id, plan, errorCode(error));
      throw error;
    } finally {
      this.busy.delete(id);
    }
  }

  /** The changes made through this connection since it was opened, newest first. */
  history(id: string): HistoryEntry[] {
    this.summary(id);
    return [...(this.histories.get(id) ?? [])].reverse();
  }

  /** Drop everything that belongs to a connection (it was disconnected). */
  forget(id: string): void {
    this.previews.clear(id);
    this.histories.delete(id);
    this.busy.delete(id);
  }

  // ------------------------------------------------------------- internals ---

  private summary(id: string) {
    const summary = this.connections.getSummary(id);
    if (!summary) throw new ServiceError("connection_not_found", WRITE_MESSAGES.connectionNotFound);
    return summary;
  }

  /** The first three switches: the flag, a local database, data viewing. */
  private requireSwitches(summary: { host: string; dataAccess: boolean }): void {
    if (!this.writesEnabled)
      throw new ServiceError("writes_not_enabled", WRITE_MESSAGES.notEnabled);
    if (!isLocalHost(summary.host)) {
      throw new ServiceError("writes_not_allowed_here", WRITE_MESSAGES.notLocal);
    }
    if (!summary.dataAccess) {
      throw new ServiceError("data_access_disabled", WRITE_MESSAGES.dataAccessOff);
    }
  }

  /** All four switches. */
  private requireUnlocked(id: string): void {
    this.requireSwitches(this.summary(id));
    if (!this.connections.isWriteUnlocked(id)) {
      throw new ServiceError("write_not_unlocked", WRITE_MESSAGES.notUnlocked);
    }
  }

  private withWritable<T>(id: string, work: (adapter: WritableAdapter) => Promise<T>): Promise<T> {
    try {
      this.requireUnlocked(id);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.connections.use(id, (adapter) => work(writable(adapter)));
  }

  private record(id: string, plan: PlannedChange, failure: string | null): HistoryEntry {
    const entry: HistoryEntry = {
      id: this.generateId(),
      at: new Date(this.now()).toISOString(),
      kind: plan.change.kind,
      table: { ...changeTable(plan.change) },
      columns: changeColumns(plan.change),
      // A row change's SQL is not kept. A change of structure keeps its SQL, unless it carries
      // text the person typed (a literal default or a comment): the history is names only.
      statement:
        plan.category === "structure" && !changeCarriesUserText(plan.change)
          ? statementText(plan)
          : null,
      outcome: failure === null ? "applied" : "failed",
      errorCode: failure,
    };
    const list = this.histories.get(id) ?? [];
    list.push(entry);
    if (list.length > MAX_HISTORY_PER_CONNECTION)
      list.splice(0, list.length - MAX_HISTORY_PER_CONNECTION);
    this.histories.set(id, list);
    return entry;
  }
}

/** The adapter's write capability, or `not_supported` when it has none. */
function writable(adapter: DatabaseAdapter): WritableAdapter {
  if (!isWritableAdapter(adapter)) {
    throw new DatabaseError("not_supported", { message: WRITE_MESSAGES.notWritable });
  }
  return adapter;
}

/** A drop needs the table's name typed by the person (decision 130). */
function checkConfirmation(change: Change): void {
  if (
    (change.kind === "drop_column" || change.kind === "drop_table") &&
    change.confirm !== change.table.name
  ) {
    throw new DatabaseError("invalid_change", { message: WRITE_MESSAGES.confirmName });
  }
}

/** The code of a failure, for the history (never its message). */
function errorCode(error: unknown): string {
  if (error instanceof ServiceError || isDatabaseError(error)) return error.code;
  return "unexpected";
}
