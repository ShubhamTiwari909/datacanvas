/** Top bar: product name on the left, backend status on the right. */
import { Database } from "lucide-react";
import { BackendStatus } from "@/features/health/backend-status";

export function Header() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2 font-semibold">
        <Database className="size-5" aria-hidden="true" />
        <span>DataCanvas</span>
      </div>
      <div className="flex items-center gap-4">
        <BackendStatus />
      </div>
    </header>
  );
}
