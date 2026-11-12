/**
 * Page frame shared by every screen: header on top, sidebar on the left, and
 * the page's own content in the main area. The page decides how to align its
 * content (centered welcome screen, full-width details panel, ...).
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
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
