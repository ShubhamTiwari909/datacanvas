/**
 * React hook: load data when a key changes, and expose loading / error / data
 * as a state machine, with a `reload` function.
 *
 *   const { state, reload } = useAsyncData(() => getSchemas(id), id);
 *   // state is one of: { status: "loading" } | { status: "error", error } | { status: "success", data }
 *
 * `key` identifies the INPUTS of the request (for example the connection id).
 * Whenever it changes the data is loaded again, and the previous request's
 * answer is ignored if it arrives late (so quickly clicking between tables can
 * never show the wrong table's details).
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFailure, ApiResult } from "./api-client";

export type AsyncState<T> =
  { status: "loading" } | { status: "error"; error: ApiFailure } | { status: "success"; data: T };

export function useAsyncData<T>(
  load: () => Promise<ApiResult<T>>,
  key: string,
): { state: AsyncState<T>; reload: () => void } {
  // The state remembers which key it belongs to. If the key has changed since,
  // the stored result is stale and we report "loading" during that render,
  // instead of briefly showing the previous key's data.
  const [stored, setStored] = useState<{
    key: string;
    attempt: number;
    state: AsyncState<T>;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Always call the latest `load` closure without making it an effect dependency.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let cancelled = false;
    void loadRef.current().then((result) => {
      if (cancelled) return; // a newer request replaced this one, or we unmounted
      setStored({
        key,
        attempt,
        state: result.ok
          ? { status: "success", data: result.data }
          : { status: "error", error: result.error },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const current = stored && stored.key === key && stored.attempt === attempt ? stored.state : null;
  return { state: current ?? { status: "loading" }, reload };
}
