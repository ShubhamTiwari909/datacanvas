/** Home route ("/"): the app shell around the workspace. */
import { AppShell } from "@/components/layout/app-shell";
import { Workspace } from "@/features/explorer/workspace";

export default function HomePage() {
  return (
    <AppShell>
      <Workspace />
    </AppShell>
  );
}
