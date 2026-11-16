/**
 * Loads the pages of one table, for ONE view of it.
 *
 * The rows live in this hook's state and nowhere else: not in a store, not in
 * `localStorage`, not in a saved workspace. They are gone when the view goes
 * away (another table, another connection, a disconnect). The page being left
 * stays on screen, dimmed, while the next one loads, so paging does not flash.
 */
"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import type { RowPage } from "@datacanvas/database-core";
import type { ApiFailure } from "@/lib/api-client";
import { getRows } from "./api";
import {
  currentCursor,
  initialPaging,
  pagingReducer,
  type PagingAction,
  type PagingState,
} from "./paging";

export interface RowsView {
  /** "loading" covers the first load and every later page; `page` is then the page being left, if any. */
  status: "loading" | "error" | "success";
  page: RowPage | null;
  error: ApiFailure | null;
  paging: PagingState;
  dispatch: (action: PagingAction) => void;
  reload: () => void;
}

interface Stored {
  key: string;
  page: RowPage | null;
  error: ApiFailure | null;
}

export function useRows(connectionId: string, schema: string, table: string): RowsView {
  const [paging, dispatch] = useReducer(pagingReducer, undefined, () => initialPaging());
  const [attempt, setAttempt] = useState(0);
  const [stored, setStored] = useState<Stored | null>(null);

  const cursor = currentCursor(paging);
  const { pageSize, reveal, sort, filters } = paging;
  // Everything that decides WHICH page is wanted. A result is only shown for the key it was asked for.
  const key = JSON.stringify([
    connectionId,
    schema,
    table,
    cursor,
    pageSize,
    [...reveal].sort(),
    sort,
    filters,
    attempt,
  ]);

  useEffect(() => {
    let cancelled = false;
    void getRows(connectionId, {
      schema,
      table,
      pageSize,
      cursor,
      revealColumns: reveal,
      sort,
      filters,
    }).then((result) => {
      if (cancelled) return; // a newer request replaced this one, or the view went away
      setStored((previous) => ({
        key,
        // Keep the last good page across an error so "Try again" has something to fall back on.
        page: result.ok ? result.data : (previous?.page ?? null),
        error: result.ok ? null : result.error,
      }));
    });
    return () => {
      cancelled = true;
    };
    // `reveal` is part of `key`; listing it separately would re-run for an equal list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const settled = stored !== null && stored.key === key;
  return {
    status: !settled ? "loading" : stored.error ? "error" : "success",
    page: stored?.page ?? null,
    error: settled ? stored.error : null,
    paging,
    dispatch,
    reload,
  };
}
