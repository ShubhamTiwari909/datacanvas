/**
 * The SQL view's state (1.6.0): per connection, its query tabs (each with a name, the text of
 * its editor, a row limit and the state of its last run) and which one is shown. MEMORY ONLY:
 * a statement can hold literals and personal data, and a result is rows, so nothing here is
 * written to browser storage or a file (decisions 125, 131 and 141; a rule test covers
 * `features/sql` and this store). Dropped with the connection, gone with the page. A tab's
 * text can be saved as a `.sql` file by the person (the view does that, in the browser).
 *
 * One statement runs at a time per connection, whichever tab it is in (the server allows no
 * more): `run` does nothing while one runs. Cancelling aborts the request, and the server
 * cancels the statement in the database. Closing the tab that runs it cancels it too.
 */
import type { SqlFailure, SqlResult } from "@datacanvas/shared-types";
import { create } from "zustand";
import { runStatement } from "@/features/sql/api";
import { DEFAULT_ROW_LIMIT, utf16Position } from "@/features/sql/result-text";

export type SqlRunState =
  | { kind: "idle" }
  | { kind: "running"; startedAt: number }
  | { kind: "cancelled" }
  /** The statement ran: its result. */
  | { kind: "result"; result: SqlResult }
  /** The database refused or stopped it (or it is not allowed): the answer, with the text it was about. */
  | { kind: "failure"; failure: SqlFailure; ranText: string; base: number; docText: string }
  /** The request itself failed (the server is busy, data viewing is off, the network). */
  | { kind: "error"; code: string; message: string };

export interface SqlTab {
  id: string;
  name: string;
  text: string;
  maxRows: number;
  state: SqlRunState;
}

/** One statement that was run: kept in memory, newest first, never saved (decision 141). */
export interface HistoryEntry {
  id: string;
  /** The statement as it was sent (for an explain, with its EXPLAIN in front). */
  text: string;
  /** When it finished, in milliseconds since 1970. */
  at: number;
  tabName: string;
  outcome: "ok" | "failed" | "cancelled";
  /** The database's code for a failure (a SQLSTATE, or `not_allowed`). */
  code: string | null;
  /** Rows of the result, for a statement that ran. */
  rows: number | null;
  elapsedMs: number;
}

export interface ConnectionSql {
  tabs: SqlTab[];
  activeId: string;
  /** The number the next new tab is named and identified by; never reused. */
  nextNumber: number;
  history: HistoryEntry[];
  /** The number the next history entry is identified by. */
  nextHistory: number;
}

export const MAX_HISTORY = 200;
/** Statements can be long: the whole history keeps at most this many characters, oldest dropped first. */
export const MAX_HISTORY_CHARS = 2_000_000;

export const MAX_TABS = 20;
export const MAX_TAB_NAME_CHARS = 60;

const newTabRecord = (number: number, over: Partial<SqlTab> = {}): SqlTab => ({
  id: `tab-${number}`,
  name: `Query ${number}`,
  text: "",
  maxRows: DEFAULT_ROW_LIMIT,
  state: { kind: "idle" },
  ...over,
});

/** What a connection shows before anything was done: one empty tab. */
const EMPTY: ConnectionSql = {
  tabs: [newTabRecord(1)],
  activeId: "tab-1",
  nextNumber: 2,
  history: [],
  nextHistory: 1,
};

/** The tab whose statement is running, if any. */
export const runningTab = (sql: ConnectionSql): SqlTab | undefined =>
  sql.tabs.find((t) => t.state.kind === "running");

interface SqlStoreState {
  byConnection: Record<string, ConnectionSql>;
  /** Add a tab (after the active one) and show it. Returns its id, or null at the limit. */
  newTab: (connectionId: string, init?: { name?: string; text?: string }) => string | null;
  selectTab: (connectionId: string, tabId: string) => void;
  closeTab: (connectionId: string, tabId: string) => void;
  renameTab: (connectionId: string, tabId: string, name: string) => void;
  duplicateTab: (connectionId: string, tabId: string) => string | null;
  setText: (connectionId: string, tabId: string, text: string) => void;
  setMaxRows: (connectionId: string, tabId: string, maxRows: number) => void;
  /**
   * Run `text` (the whole editor or a selection that starts `base` characters in) from a tab.
   * `prefix` is sent in front of it (`EXPLAIN `): the answer's position is counted from `text`.
   */
  run: (
    connectionId: string,
    tabId: string,
    text: string,
    base?: number,
    prefix?: string,
  ) => Promise<void>;
  clearHistory: (connectionId: string) => void;
  /** Cancel the statement running on the connection, if any. */
  cancel: (connectionId: string) => void;
  forgetConnection: (connectionId: string) => void;
}

/** The request of each running statement (one per connection), so Cancel can abort it. Not state. */
const controllers = new Map<string, AbortController>();
/** When a statement was last cancelled here: the server may need a moment to let go of the connection. */
const cancelledAt = new Map<string, number>();

const BUSY_RETRY_MS = 300;
const BUSY_RETRIES = 8;

export const useSqlStore = create<SqlStoreState>((set, get) => {
  const current = (id: string): ConnectionSql => get().byConnection[id] ?? EMPTY;
  const write = (id: string, next: ConnectionSql) =>
    set((s) => ({ byConnection: { ...s.byConnection, [id]: next } }));
  const patchTab = (id: string, tabId: string, patch: Partial<SqlTab>) => {
    const sql = current(id);
    if (!sql.tabs.some((t) => t.id === tabId)) return;
    write(id, { ...sql, tabs: sql.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) });
  };
  const insertAfterActive = (id: string, tab: SqlTab): void => {
    const sql = current(id);
    const at = sql.tabs.findIndex((t) => t.id === sql.activeId);
    const tabs = [...sql.tabs.slice(0, at + 1), tab, ...sql.tabs.slice(at + 1)];
    write(id, { ...sql, tabs, activeId: tab.id, nextNumber: sql.nextNumber + 1 });
  };
  const record = (id: string, entry: Omit<HistoryEntry, "id">) => {
    const sql = current(id);
    let history = [{ ...entry, id: `h-${sql.nextHistory}` }, ...sql.history].slice(0, MAX_HISTORY);
    let chars = 0;
    history = history.filter((h, i) => {
      chars += h.text.length;
      return i === 0 || chars <= MAX_HISTORY_CHARS;
    });
    write(id, { ...sql, history, nextHistory: sql.nextHistory + 1 });
  };

  return {
    byConnection: {},

    newTab(id, init = {}) {
      const sql = current(id);
      if (sql.tabs.length >= MAX_TABS) return null;
      const tab = newTabRecord(sql.nextNumber, {
        ...(init.name ? { name: init.name.slice(0, MAX_TAB_NAME_CHARS) } : {}),
        text: init.text ?? "",
      });
      insertAfterActive(id, tab);
      return tab.id;
    },

    selectTab(id, tabId) {
      const sql = current(id);
      if (sql.activeId === tabId || !sql.tabs.some((t) => t.id === tabId)) return;
      write(id, { ...sql, activeId: tabId });
    },

    closeTab(id, tabId) {
      const sql = current(id);
      const at = sql.tabs.findIndex((t) => t.id === tabId);
      if (at < 0) return;
      // Closing the tab that runs the statement cancels it.
      if (sql.tabs[at]!.state.kind === "running") get().cancel(id);
      const tabs = sql.tabs.filter((t) => t.id !== tabId);
      if (tabs.length === 0) {
        // The last tab is replaced by an empty one.
        const fresh = newTabRecord(sql.nextNumber);
        write(id, { ...sql, tabs: [fresh], activeId: fresh.id, nextNumber: sql.nextNumber + 1 });
        return;
      }
      const activeId =
        sql.activeId === tabId ? tabs[Math.min(at, tabs.length - 1)]!.id : sql.activeId;
      write(id, { ...sql, tabs, activeId });
    },

    renameTab(id, tabId, name) {
      const trimmed = name.trim().slice(0, MAX_TAB_NAME_CHARS);
      if (trimmed) patchTab(id, tabId, { name: trimmed });
    },

    duplicateTab(id, tabId) {
      const sql = current(id);
      const source = sql.tabs.find((t) => t.id === tabId);
      if (!source || sql.tabs.length >= MAX_TABS) return null;
      const copy = newTabRecord(sql.nextNumber, {
        name: `${source.name} (copy)`.slice(0, MAX_TAB_NAME_CHARS),
        text: source.text,
        maxRows: source.maxRows,
      });
      // The copy goes right after the source, whichever tab is shown.
      const at = sql.tabs.findIndex((t) => t.id === tabId);
      write(id, {
        ...sql,
        tabs: [...sql.tabs.slice(0, at + 1), copy, ...sql.tabs.slice(at + 1)],
        activeId: copy.id,
        nextNumber: sql.nextNumber + 1,
      });
      return copy.id;
    },

    setText: (id, tabId, text) => patchTab(id, tabId, { text }),
    setMaxRows: (id, tabId, maxRows) => patchTab(id, tabId, { maxRows }),

    async run(id, tabId, text, base = 0, prefix = "") {
      const before = current(id);
      if (runningTab(before)) return;
      const tab = before.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const controller = new AbortController();
      controllers.set(id, controller);
      const startedAt = Date.now();
      patchTab(id, tabId, { state: { kind: "running", startedAt } });
      const sent = prefix + text;
      const { maxRows } = tab;
      const docText = tab.text;

      // Right after a Cancel the server may still be letting go: wait a little, a few times.
      let result = await runStatement(id, { text: sent, maxRows }, controller.signal);
      for (
        let i = 0;
        i < BUSY_RETRIES &&
        !result.ok &&
        result.error.code === "sql_busy" &&
        Date.now() - (cancelledAt.get(id) ?? 0) < 5000 &&
        !controller.signal.aborted;
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
        result = await runStatement(id, { text: sent, maxRows }, controller.signal);
      }

      if (controllers.get(id) === controller) controllers.delete(id);
      // The connection may have been closed meanwhile: then there is nothing to keep.
      if (!get().byConnection[id]) return;
      const tabName = tab.name;
      const took = Date.now() - startedAt;
      // What happened goes into the history, even when the tab was closed meanwhile. A request
      // that failed (the server was busy, data viewing off) is not a statement that ran.
      if (result.ok) {
        const answer = result.data;
        if ("failure" in answer) {
          record(id, {
            text: sent,
            at: Date.now(),
            tabName,
            outcome: answer.failure.code === "cancelled" ? "cancelled" : "failed",
            code: answer.failure.code === "cancelled" ? null : answer.failure.code,
            rows: null,
            elapsedMs: took,
          });
        } else {
          record(id, {
            text: sent,
            at: Date.now(),
            tabName,
            outcome: "ok",
            code: null,
            rows: answer.result.rows.length,
            elapsedMs: answer.result.elapsedMs,
          });
        }
      } else if (result.error.code === "aborted") {
        record(id, {
          text: sent,
          at: Date.now(),
          tabName,
          outcome: "cancelled",
          code: null,
          rows: null,
          elapsedMs: took,
        });
      }
      // The tab may have been closed meanwhile: then there is nothing to show in it.
      if (!get().byConnection[id]?.tabs.some((t) => t.id === tabId)) return;
      if (!result.ok) {
        patchTab(id, tabId, {
          state:
            result.error.code === "aborted"
              ? { kind: "cancelled" }
              : { kind: "error", code: result.error.code, message: result.error.message },
        });
      } else if ("failure" in result.data) {
        // The position counts from the text sent; the person's text starts after the prefix.
        const { failure: sentFailure } = result.data;
        // ... and in characters, where the editor counts UTF-16 units.
        const position =
          sentFailure.position === null || sentFailure.position <= prefix.length
            ? null
            : utf16Position(text, sentFailure.position - prefix.length);
        const failure = { ...sentFailure, position };
        patchTab(id, tabId, {
          state:
            failure.code === "cancelled"
              ? { kind: "cancelled" }
              : {
                  kind: "failure",
                  failure,
                  ranText: text,
                  base,
                  // The whole editor text at the time: the mark means something only while it is unchanged.
                  docText,
                },
        });
      } else {
        patchTab(id, tabId, { state: { kind: "result", result: result.data.result } });
      }
    },

    clearHistory(id) {
      const sql = get().byConnection[id];
      if (sql) write(id, { ...sql, history: [] });
    },

    cancel(id) {
      const controller = controllers.get(id);
      if (!controller) return;
      cancelledAt.set(id, Date.now());
      controller.abort();
    },

    forgetConnection(id) {
      controllers.get(id)?.abort();
      controllers.delete(id);
      cancelledAt.delete(id);
      set((s) => {
        const { [id]: _gone, ...rest } = s.byConnection;
        void _gone;
        return { byConnection: rest };
      });
    },
  };
});

/** What the view shows for one connection (one empty tab before anything was done). */
export function useConnectionSql(connectionId: string): ConnectionSql {
  return useSqlStore((s) => s.byConnection[connectionId] ?? EMPTY);
}

/** The text of a tab, read now (for a new editor model; not a subscription). */
export function tabText(connectionId: string, tabId: string): string {
  return (
    (useSqlStore.getState().byConnection[connectionId] ?? EMPTY).tabs.find((t) => t.id === tabId)
      ?.text ?? ""
  );
}
