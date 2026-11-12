/**
 * Page frame shared by every screen: header on top, sidebar on the left, and
 * the page's own content in the main area.
 *
 * A Server Component: it only arranges layout, so it needs no client JavaScript.
 */
import { Header } from "./header";
import { Sidebar } from "./sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex flex-1 items-center justify-center overflow-auto">{children}</main>
      </div>
    </div>
  );
}
