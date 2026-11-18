/**
 * Left sidebar frame. On a wide screen (`md` and up) it is a fixed column. On a phone it is a drawer that
 * slides in from the left, opened by the menu button in the header (`MobileNavButton`); picking a table or a
 * connection, pressing Escape or tapping outside closes it. It is one element in both cases, so the
 * connections and the schema tree exist once. Closed on a phone it is `invisible`: out of the tab order and
 * hidden from screen readers.
 */
"use client";

import { useEffect, useRef } from "react";
import { cn } from "cn";
import { ConnectionsSidebar } from "@/features/connections/connections-sidebar";
import { useNavStore } from "@/stores/nav-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

export function Sidebar() {
  const open = useNavStore((s) => s.drawerOpen);
  const setOpen = useNavStore((s) => s.setDrawerOpen);
  const table = useWorkspaceStore((s) => s.selectedTable);
  const connectionId = useWorkspaceStore((s) => s.selectedConnectionId);
  const ref = useRef<HTMLElement>(null);

  // Picking something closes the drawer (state adjusted when the selection changes).
  useEffect(() => {
    setOpen(false);
  }, [table, connectionId, setOpen]);

  useEffect(() => {
    if (!open) return;
    ref.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A dialog opened from the drawer takes Escape first.
      if (document.querySelector("[role=dialog]")) return;
      setOpen(false);
      document.getElementById("open-sidebar")?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  return (
    <>
      {open ? (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setOpen(false)}
        />
      ) : null}
      <aside
        ref={ref}
        tabIndex={-1}
        aria-label="Connections and schema explorer"
        className={cn(
          "flex w-72 max-w-[85vw] shrink-0 flex-col gap-2 border-r bg-sidebar p-4 outline-none",
          "fixed inset-y-0 left-0 z-40 shadow-xl transition-[transform,visibility] duration-200 motion-reduce:transition-none",
          "md:visible md:static md:translate-x-0 md:shadow-none",
          open ? "visible translate-x-0" : "invisible -translate-x-full",
        )}
      >
        <ConnectionsSidebar />
      </aside>
    </>
  );
}
