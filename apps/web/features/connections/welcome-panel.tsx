/** First-run screen: explains the product in one line and offers the single next step. */
import { DatabaseZap } from "lucide-react";
import { EmptyState } from "@/components/states/empty-state";
import { ConnectPostgresButton } from "./connect-postgres-button";

export function WelcomePanel() {
  return (
    <EmptyState
      icon={DatabaseZap}
      title="Welcome to DataCanvas"
      description="Connect your first database to explore its tables and relationships. Everything runs on your machine."
    >
      <ConnectPostgresButton />
    </EmptyState>
  );
}
