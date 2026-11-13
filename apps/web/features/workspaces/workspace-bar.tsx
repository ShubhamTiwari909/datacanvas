/**
 * The bar above the canvas: which layout is open, the autosave status, and the
 * menu to switch, create, rename, export, import and delete layouts.
 *
 * Layouts can only be kept for a connection that has been SAVED (its non-secret
 * details written to disk), because the file needs something to be found by
 * after a restart. For an unsaved connection the bar offers "Save connection".
 */
"use client";

import { useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  FileDown,
  FileUp,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { usePersistenceStore } from "@/stores/persistence-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  deleteActiveWorkspace,
  exportActiveWorkspace,
  importWorkspaceFile,
  newWorkspace,
  openWorkspace,
  renameActiveWorkspace,
  saveCurrentConnection,
  type ActionResult,
} from "./workspace-actions";

type Dialogs = "rename" | "delete" | null;

export function WorkspaceBar({ connectionId }: { connectionId: string }) {
  const connection = useWorkspaceStore((s) => s.connections.find((c) => c.id === connectionId));
  const profileId = connection?.profileId ?? null;
  const active = usePersistenceStore((s) => s.active[connectionId]);
  const summaries =
    usePersistenceStore((s) => (profileId ? s.summaries[profileId] : undefined)) ?? [];
  const saveState = usePersistenceStore((s) => s.saveState[connectionId]);
  const notice = usePersistenceStore((s) => s.notices[connectionId]);
  const setNotice = usePersistenceStore((s) => s.setNotice);

  const [dialog, setDialog] = useState<Dialogs>(null);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /** Run an action, showing any failure in the bar. */
  async function run(action: () => Promise<ActionResult>) {
    setError(null);
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (!result.ok) setError(result.message);
    return result.ok;
  }

  // An unsaved connection cannot keep layouts: say so, and offer the fix.
  if (!profileId) {
    return (
      <div className="flex flex-wrap items-center gap-3 border-b px-3 py-1.5 text-sm">
        <span className="text-muted-foreground">
          This layout is not saved: it is lost when you close DataCanvas.
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void run(() => saveCurrentConnection(connectionId))}
        >
          {busy ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Save aria-hidden="true" />
          )}
          Save connection
        </Button>
        <span className="text-xs text-muted-foreground">
          (Saves host, database and user, never the password.)
        </span>
        {error ? (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        ) : null}
      </div>
    );
  }

  const name = active?.name ?? "Layout";
  return (
    <div className="border-b">
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Workspace: ${name}. Open the workspace menu`}
            >
              <FolderOpen aria-hidden="true" />
              <span className="max-w-48 truncate">{name}</span>
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-64">
            <DropdownMenuLabel>Workspaces for this connection</DropdownMenuLabel>
            {summaries.length === 0 ? (
              <DropdownMenuItem disabled>None saved yet</DropdownMenuItem>
            ) : (
              summaries.map((w) => (
                <DropdownMenuItem
                  key={w.id}
                  onSelect={() => void run(() => openWorkspace(connectionId, w.id))}
                >
                  <Check
                    className={w.id === active?.id ? "opacity-100" : "opacity-0"}
                    aria-hidden="true"
                  />
                  <span className="truncate">{w.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {w.tableCount} tables
                  </span>
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void run(() => newWorkspace(connectionId))}>
              <Plus aria-hidden="true" /> New workspace
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                setDraftName(name);
                setDialog("rename");
              }}
            >
              <Pencil aria-hidden="true" /> Rename…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!active?.id}
              onSelect={() => void run(() => exportActiveWorkspace(connectionId))}
            >
              <FileDown aria-hidden="true" /> Export to a file
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
              <FileUp aria-hidden="true" /> Import from a file…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={!active?.id}
              onSelect={() => setDialog("delete")}
            >
              <Trash2 aria-hidden="true" /> Delete this workspace…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <SaveStatus state={saveState} hasWorkspace={Boolean(active?.id)} />
        {error ? (
          <span role="alert" className="flex items-center gap-1 text-sm text-destructive">
            <AlertCircle className="size-4" aria-hidden="true" /> {error}
          </span>
        ) : null}
      </div>

      {notice ? (
        <div
          role="status"
          className="flex items-start gap-2 border-t bg-amber-50 px-3 py-1.5 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{notice}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss"
            onClick={() => setNotice(connectionId, null)}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        aria-label="Import a workspace file"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = ""; // allow choosing the same file again later
          if (file) void run(() => importWorkspaceFile(connectionId, file));
        }}
      />

      <Dialog open={dialog === "rename"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
            <DialogDescription>
              The name is only for you; it does not change the database.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => renameActiveWorkspace(connectionId, draftName)).then(
                (ok) => ok && setDialog(null),
              );
            }}
          >
            <Input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              aria-label="Workspace name"
              maxLength={100}
              autoFocus
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button type="submit">Rename</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "delete"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{name}”?</DialogTitle>
            <DialogDescription>
              This deletes the saved layout. Your database is not touched, and you can build a new
              layout any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                void run(() => deleteActiveWorkspace(connectionId)).then(() => setDialog(null))
              }
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SaveStatus({
  state,
  hasWorkspace,
}: {
  state: ReturnType<typeof usePersistenceStore.getState>["saveState"][string];
  hasWorkspace: boolean;
}) {
  if (state?.status === "saving") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Saving…
      </span>
    );
  }
  if (state?.status === "error") {
    return (
      <span role="alert" className="flex items-center gap-1 text-xs text-destructive">
        <AlertCircle className="size-3.5" aria-hidden="true" /> Not saved: {state.message}
      </span>
    );
  }
  if (state?.status === "saved" || hasWorkspace) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
        <Check className="size-3.5" aria-hidden="true" /> Saved
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">Changes are saved automatically</span>;
}
