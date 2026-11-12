/**
 * The main area: decides what to show from the shared state.
 *
 *   loading connections          -> spinner
 *   could not load               -> error with retry
 *   no connections               -> welcome screen
 *   connection, no table chosen  -> prompt to pick one
 *   connection and table chosen  -> the table's details
 */
"use client";

import { useEffect } from "react";
import { TableProperties } from "lucide-react";
import { ErrorState } from "@/components/states/error-state";
import { EmptyState } from "@/components/states/empty-state";
import { LoadingState } from "@/components/states/loading-state";
import { ConnectDialog } from "@/features/connections/connect-dialog";
import { WelcomePanel } from "@/features/connections/welcome-panel";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { TableDetails } from "./table-details";

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full items-center justify-center">{children}</div>;
}

export function Workspace() {
  const status = useWorkspaceStore((s) => s.status);
  const loadError = useWorkspaceStore((s) => s.loadError);
  const connections = useWorkspaceStore((s) => s.connections);
  const selectedId = useWorkspaceStore((s) => s.selectedConnectionId);
  const table = useWorkspaceStore((s) => s.selectedTable);
  const loadConnections = useWorkspaceStore((s) => s.loadConnections);

  // Ask the server which connections exist (they survive a page reload).
  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  const connection = connections.find((c) => c.id === selectedId);

  let content: React.ReactNode;
  if (status === "loading") {
    content = (
      <Centered>
        <LoadingState label="Loading connections…" />
      </Centered>
    );
  } else if (status === "error") {
    content = (
      <Centered>
        <ErrorState
          title="Could not load connections"
          message={loadError ?? "Unknown error."}
          onRetry={() => void loadConnections()}
        />
      </Centered>
    );
  } else if (!connection) {
    content = (
      <Centered>
        <WelcomePanel />
      </Centered>
    );
  } else if (!table) {
    content = (
      <Centered>
        <EmptyState
          icon={TableProperties}
          title="Pick a table"
          description={`Connected to ${connection.database} on ${connection.host}. Choose a table or view in the sidebar to see its columns, constraints, indexes and relationships.`}
        />
      </Centered>
    );
  } else {
    // `key` makes the panel start fresh when the connection or table changes.
    content = (
      <TableDetails
        key={`${connection.id}/${table.schema}/${table.name}`}
        connectionId={connection.id}
        schema={table.schema}
        table={table.name}
      />
    );
  }

  return (
    <>
      {content}
      <ConnectDialog />
    </>
  );
}
