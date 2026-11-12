/**
 * Reusable error panel with an optional retry button.
 *
 * Security note: pass only human-readable, already-sanitised messages. Never
 * pass raw driver errors, SQL, or connection strings; later phases map
 * database errors to safe messages before they reach the UI.
 */
"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

type ErrorStateProps = {
  title?: string;
  message: string;
  /** When provided, a "Try again" button is shown. */
  onRetry?: () => void;
};

export function ErrorState({ title = "Something went wrong", message, onRetry }: ErrorStateProps) {
  return (
    // role="alert" makes screen readers announce the error immediately.
    <div role="alert" className="flex flex-col items-center gap-3 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
      </div>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {onRetry ? (
        <Button variant="outline" onClick={onRetry} className="mt-2">
          Try again
        </Button>
      ) : null}
    </div>
  );
}
