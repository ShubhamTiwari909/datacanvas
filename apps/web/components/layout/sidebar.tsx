/**
 * Left sidebar frame. The content (connections and the schema tree) is a
 * Client Component because it reads shared state.
 *
 * Hidden below the `md` breakpoint so the workspace gets the full width on
 * phones; a mobile navigation pattern can be added later if needed.
 */
import { ConnectionsSidebar } from "@/features/connections/connections-sidebar";

export function Sidebar() {
  return (
    <aside
      aria-label="Connections and schema explorer"
      className="hidden w-72 shrink-0 flex-col gap-2 border-r bg-sidebar p-4 md:flex"
    >
      <ConnectionsSidebar />
    </aside>
  );
}
