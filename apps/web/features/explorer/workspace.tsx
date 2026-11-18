/**
 * The main area: decides what to show from the shared state.
 *
 *   loading connections          -> spinner
 *   could not load               -> error with retry
 *   no connections               -> welcome screen
 *   connection selected          -> tabs: Canvas | Overview | Paths | Health | Objects | Snapshots | Table details
 */
"use client";

import { useEffect } from "react";
import {
  Boxes,
  Camera,
  HeartPulse,
  LayoutDashboard,
  LayoutList,
  Route,
  TableProperties,
} from "lucide-react";
import { ErrorState } from "@/components/states/error-state";
import { EmptyState } from "@/components/states/empty-state";
import { LoadingState } from "@/components/states/loading-state";
import { Button } from "@/components/ui/button";
import { CanvasView } from "@/features/canvas/canvas-view";
import { ConnectDialog } from "@/features/connections/connect-dialog";
import { WelcomePanel } from "@/features/connections/welcome-panel";
import { HealthView } from "@/features/health/health-view";
import { PathView } from "@/features/paths/path-view";
import { SchemaOverviewView } from "@/features/overview/schema-overview-view";
import { ObjectsView } from "@/features/objects/objects-view";
import { SnapshotsView } from "@/features/snapshots/snapshots-view";
import { autosaver } from "@/features/workspaces/autosave-instance";
import { useWorkspaceStore, type WorkspaceView } from "@/stores/workspace-store";
import { TableDetails } from "./table-details";

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full items-center justify-center">{children}</div>;
}

const TABS: Array<{ view: WorkspaceView; label: string; icon: typeof LayoutDashboard }> = [
  { view: "canvas", label: "Canvas", icon: LayoutDashboard },
  { view: "overview", label: "Overview", icon: LayoutList },
  { view: "paths", label: "Paths", icon: Route },
  { view: "health", label: "Health", icon: HeartPulse },
  { view: "objects", label: "Objects", icon: Boxes },
  { view: "snapshots", label: "Snapshots", icon: Camera },
  { view: "details", label: "Table details", icon: TableProperties },
];

function ViewTabs() {
  const view = useWorkspaceStore((s) => s.view);
  const setView = useWorkspaceStore((s) => s.setView);
  return (
    <div
      role="tablist"
      aria-label="View"
      className="flex gap-1 overflow-x-auto border-b px-3 py-1.5 [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-24px),transparent)] [scrollbar-width:none] md:[mask-image:none] [&>*]:shrink-0"
    >
      {TABS.map(({ view: value, label, icon: Icon }) => (
        <Button
          key={value}
          type="button"
          role="tab"
          aria-selected={view === value}
          variant={view === value ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setView(value)}
        >
          <Icon aria-hidden="true" />
          {label}
        </Button>
      ))}
    </div>
  );
}

export function Workspace() {
  const status = useWorkspaceStore((s) => s.status);
  const loadError = useWorkspaceStore((s) => s.loadError);
  const connections = useWorkspaceStore((s) => s.connections);
  const selectedId = useWorkspaceStore((s) => s.selectedConnectionId);
  const table = useWorkspaceStore((s) => s.selectedTable);
  const view = useWorkspaceStore((s) => s.view);
  const loadConnections = useWorkspaceStore((s) => s.loadConnections);

  // Keep the saved layout up to date while the user works (stops when the page closes).
  useEffect(() => autosaver.start(), []);

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
  } else {
    content = (
      <div className="flex h-full flex-col">
        <ViewTabs />
        <div className="min-h-0 flex-1 overflow-auto">
          {view === "canvas" ? (
            // `key` gives each connection its own canvas instance (and viewport).
            <CanvasView key={connection.id} connectionId={connection.id} />
          ) : view === "overview" ? (
            <SchemaOverviewView key={connection.id} connectionId={connection.id} />
          ) : view === "paths" ? (
            <PathView key={connection.id} connectionId={connection.id} />
          ) : view === "health" ? (
            <HealthView key={connection.id} connectionId={connection.id} />
          ) : view === "objects" ? (
            <ObjectsView key={connection.id} connectionId={connection.id} />
          ) : view === "snapshots" ? (
            <SnapshotsView key={connection.id} connectionId={connection.id} />
          ) : table ? (
            <TableDetails
              key={`${connection.id}/${table.schema}/${table.name}`}
              connectionId={connection.id}
              schema={table.schema}
              table={table.name}
            />
          ) : (
            <Centered>
              <EmptyState
                icon={TableProperties}
                title="Pick a table"
                description={`Connected to ${connection.database} on ${connection.host}. Choose a table or view in the sidebar to see its columns, constraints, indexes and relationships.`}
              />
            </Centered>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {content}
      <ConnectDialog />
    </>
  );
}
