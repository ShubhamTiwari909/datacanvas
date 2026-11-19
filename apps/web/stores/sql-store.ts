/**
 * The SQL view's state (1.6.0): per connection, the text of the editor, the row limit and
 * the state of the last run. MEMORY ONLY: a statement can hold literals and personal data,
 * and a result is rows, so nothing here is written to browser storage or a file (decisions
 * 125, 131 and 141; a rule test covers `features/sql` and this store). Dropped with the
 * connection, gone with the page.
 *
 * One run at a time per connection: `run` does nothing while one is running. Cancelling
 * aborts the request, and the server cancels the statement in the database.
 */
import type { SqlFailure, SqlResult } from "@datacanvas/shared-types";
import { create } from "zustand";
import { runStatement } from "@/features/sql/api";
import { DEFAULT_ROW_LIMIT } from "@/features/sql/result-text";

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

export interface ConnectionSql {
  text: string;
  maxRows: number;
  state: SqlRunState;
}

const EMPTY: ConnectionSql = { text: "", maxRows: DEFAULT_ROW_LIMIT, state: { kind: "idle" } };

interface SqlStoreState {
  byConnection: Record<string, ConnectionSql>;
  setText: (connectionId: string, text: string) => void;
  setMaxRows: (connectionId: string, maxRows: number) => void;
  /** Run `text` (the whole editor or a selection that starts `base` characters in). */
  run: (connectionId: string, text: string, base?: number) => Promise<void>;
  cancel: (connectionId: string) => void;
  forgetConnection: (connectionId: string) => void;
}

/** The request of each running statement, so Cancel can abort it. Not state: nothing renders from it. */
const controllers = new Map<string, AbortController>();
/** When a statement was last cancelled here: the server may need a moment to let go of the connection. */
const cancelledAt = new Map<string, number>();

const BUSY_RETRY_MS = 300;
const BUSY_RETRIES = 8;

export const useSqlStore = create<SqlStoreState>((set, get) => {
  const update = (id: string, patch: Partial<ConnectionSql>) =>
    set((s) => ({
      byConnection: {
        ...s.byConnection,
        [id]: { ...(s.byConnection[id] ?? EMPTY), ...patch },
      },
    }));

  return {
    byConnection: {},

    setText: (id, text) => update(id, { text }),
    setMaxRows: (id, maxRows) => update(id, { maxRows }),

    async run(id, text, base = 0) {
      if (get().byConnection[id]?.state.kind === "running") return;
      const controller = new AbortController();
      controllers.set(id, controller);
      update(id, { state: { kind: "running", startedAt: Date.now() } });
      const maxRows = get().byConnection[id]?.maxRows ?? DEFAULT_ROW_LIMIT;

      // Right after a Cancel the server may still be letting go: wait a little, a few times.
      let result = await runStatement(id, { text, maxRows }, controller.signal);
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
        result = await runStatement(id, { text, maxRows }, controller.signal);
      }

      if (controllers.get(id) === controller) controllers.delete(id);
      // The connection may have been closed meanwhile: then there is nothing to show.
      if (!get().byConnection[id]) return;
      if (!result.ok) {
        update(id, {
          state:
            result.error.code === "aborted"
              ? { kind: "cancelled" }
              : { kind: "error", code: result.error.code, message: result.error.message },
        });
      } else if ("failure" in result.data) {
        const { failure } = result.data;
        update(id, {
          state:
            failure.code === "cancelled"
              ? { kind: "cancelled" }
              : {
                  kind: "failure",
                  failure,
                  ranText: text,
                  base,
                  // The whole editor text at the time: the mark means something only while it is unchanged.
                  docText: get().byConnection[id]?.text ?? text,
                },
        });
      } else {
        update(id, { state: { kind: "result", result: result.data.result } });
      }
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

/** What the view shows for one connection (an empty editor before anything was typed). */
export function useConnectionSql(connectionId: string): ConnectionSql {
  return useSqlStore((s) => s.byConnection[connectionId] ?? EMPTY);
}
