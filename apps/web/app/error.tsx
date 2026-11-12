/**
 * Route-level error boundary. Next.js renders this when something throws while
 * rendering a page. It must be a Client Component because it receives a
 * `reset` callback that re-renders the failed segment.
 *
 * The raw error is intentionally NOT shown: it may contain internals. In
 * production Next.js already replaces server error messages with a generic
 * one plus a `digest` id that can be matched against the server log.
 */
"use client";

import { ErrorState } from "@/components/states/error-state";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorState
      message={`An unexpected error occurred.${error.digest ? ` (reference: ${error.digest})` : ""}`}
      onRetry={reset}
    />
  );
}
