/**
 * Left sidebar listing connections. In Phase 1 it is always empty; Phase 6
 * fills it with real saved connections.
 *
 * Hidden below the `md` breakpoint so the workspace gets the full width on
 * phones; a mobile navigation pattern can be added later if needed.
 */
export function Sidebar() {
  return (
    <aside
      aria-label="Connections"
      className="hidden w-64 shrink-0 flex-col gap-2 border-r bg-sidebar p-4 md:flex"
    >
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Connections
      </h2>
      <p className="text-sm text-muted-foreground">No connections yet.</p>
    </aside>
  );
}
