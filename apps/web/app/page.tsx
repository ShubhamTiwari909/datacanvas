/** Home route ("/"): the app shell around the welcome screen. */
import { AppShell } from "@/components/layout/app-shell";
import { WelcomePanel } from "@/features/connections/welcome-panel";

export default function HomePage() {
  return (
    <AppShell>
      <WelcomePanel />
    </AppShell>
  );
}
