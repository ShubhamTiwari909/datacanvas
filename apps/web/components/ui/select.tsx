import * as React from "react";
import { cn } from "cn";

/**
 * The class of a native `<select>`: the same height, text size, border, radius and
 * focus ring as `Input`. Exported as a string for the places that style a select
 * without this component.
 */
export const SELECT_CLASS =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/30";

/** A native select. Native on purpose: keyboard, screen reader and touch behaviour come for free. */
function Select({ className, ...props }: React.ComponentProps<"select">) {
  return <select data-slot="select" className={cn(SELECT_CLASS, className)} {...props} />;
}

export { Select };
