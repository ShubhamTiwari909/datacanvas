/**
 * Page frame shared by every screen: header on top, sidebar on the left, and
 * the page's own content in the main area. The page decides how to align its
 * content (centered welcome screen, full-width details panel, ...).
 *
 * A Server Component: it only arranges layout, so it needs no client JavaScript.
 */
import { ClaudeActivityHost } from "@/features/claude/activity-host";
import { Header } from "./header";
import { Sidebar } from "./sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    // `relative` + `overflow-hidden`: the frame is exactly one screen tall and the page itself must never
    // scroll. Screen-reader-only text (`sr-only`) is absolutely positioned; with no positioned ancestor it
    // escapes the scroll areas inside (the table list, the rows grid) and stretches the whole document,
    // so a long list let the page scroll and left a blank area under the canvas.
    <div className="relative flex h-screen flex-col overflow-hidden">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
      <ClaudeActivityHost />
    </div>
  );
}
