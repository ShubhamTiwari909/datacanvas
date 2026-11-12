/**
 * Reusable "something is loading" indicator.
 *
 * Used by route-level `loading.tsx` files now, and by data-fetching components
 * (connection test, schema explorer, canvas) in later phases.
 */
import { Loader2 } from "lucide-react";

type LoadingStateProps = {
  /** Short text shown next to the spinner. */
  label?: string;
};

export function LoadingState({ label = "Loading…" }: LoadingStateProps) {
  return (
    // role="status" makes screen readers announce the text politely.
    <div role="status" className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span className="text-sm">{label}</span>
    </div>
  );
}
