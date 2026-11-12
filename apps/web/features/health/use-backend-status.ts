/**
 * React hook that asks the local server whether it is alive (`GET /api/health`).
 *
 * Client-side only. The status moves through three states:
 *   "checking"    request in flight (the initial state)
 *   "connected"   server answered with a valid health response
 *   "unreachable" network error, timeout, non-2xx status, or unexpected body
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { APP_NAME } from "@datacanvas/shared-types";

export type BackendStatus = "checking" | "connected" | "unreachable";

/** Give up after this long so a hung server shows "unreachable" instead of spinning forever. */
const REQUEST_TIMEOUT_MS = 3000;

/**
 * Runtime check of the response body. Data arriving over HTTP is `unknown`
 * until verified; TypeScript types alone cannot guarantee it. (Phase 3 replaces
 * this hand-written check with a shared Zod schema.)
 */
function isHealthyResponse(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "status" in body &&
    body.status === "ok" &&
    "application" in body &&
    body.application === APP_NAME
  );
}

export function useBackendStatus(): { status: BackendStatus; retry: () => void } {
  const [status, setStatus] = useState<BackendStatus>("checking");
  // Bumping this number re-runs the effect below, which re-checks the server.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // `cancelled` guards against updating state after the component unmounted
    // (or after React re-ran this effect). In development React StrictMode runs
    // every effect twice, so this matters in practice.
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    void (async () => {
      let next: BackendStatus = "unreachable";
      try {
        const response = await fetch("/api/health", {
          signal: controller.signal,
          cache: "no-store",
        });
        const body: unknown = await response.json();
        if (response.ok && isHealthyResponse(body)) next = "connected";
      } catch {
        // Network failure, timeout (abort), or invalid JSON: stays "unreachable".
      } finally {
        clearTimeout(timer);
      }
      if (!cancelled) setStatus(next);
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setStatus("checking");
    setAttempt((n) => n + 1);
  }, []);

  return { status, retry };
}
