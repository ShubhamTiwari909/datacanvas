/** Top bar: product name on the left, global actions on the right. */
import { Database, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Header() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2 font-semibold">
        <Database className="size-5" aria-hidden="true" />
        <span>DataCanvas</span>
      </div>
      {/* Disabled until a settings screen exists (not part of the MVP phases yet). */}
      <Button variant="ghost" size="sm" disabled title="Settings are not available yet">
        <Settings aria-hidden="true" />
        Settings
      </Button>
    </header>
  );
}
