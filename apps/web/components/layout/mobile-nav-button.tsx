/** The menu button in the header that opens the sidebar drawer. Only on a phone (below `md`). */
"use client";

import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavStore } from "@/stores/nav-store";

export function MobileNavButton() {
  const open = useNavStore((s) => s.drawerOpen);
  const setOpen = useNavStore((s) => s.setDrawerOpen);
  return (
    <Button
      id="open-sidebar"
      type="button"
      variant="ghost"
      size="icon"
      className="-ml-2 md:hidden"
      aria-label="Open connections and tables"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      <Menu aria-hidden="true" />
    </Button>
  );
}
