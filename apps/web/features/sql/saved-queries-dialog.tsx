/** Explicitly save or reopen SQL text for the current connection. Running a query is a separate action. */
"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bookmark, Pencil, Save, SquarePlus, Trash2 } from "lucide-react";
import {
  MAX_SAVED_QUERY_NAME_CHARS,
  SQL_MAX_TEXT_CHARS,
  type SavedQuery,
  type SavedQuerySummary,
} from "@datacanvas/shared-types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ApiResult } from "@/lib/api-client";
import { useAsyncData } from "@/lib/use-async-data";
import {
  deleteSavedQuery,
  getSavedQuery,
  listSavedQueries,
  editSavedQuery,
  saveQuery,
} from "./api";

interface Props {
  connectionId: string;
  persistent: boolean;
  tab: { name: string; text: string };
  onClose: () => void;
  /** Return a message if the query cannot be opened. */
  onOpen: (query: SavedQuery) => string | null;
}

export function SavedQueriesDialog(props: Props) {
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size="form" className="flex flex-col pb-(--dialog-pad)">
        <Library {...props} />
      </DialogContent>
    </Dialog>
  );
}

type RowAction =
  { kind: "rename"; id: string; name: string } | { kind: "remove" | "replace"; id: string };

function Library({ connectionId, persistent, tab, onOpen }: Props) {
  const { state, reload } = useAsyncData(() => listSavedQueries(connectionId), connectionId);
  const [updated, setUpdated] = useState<SavedQuerySummary[] | null>(null);
  const [search, setSearch] = useState("");
  const [name, setName] = useState(tab.name);
  const [rowAction, setRowAction] = useState<RowAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function perform<T>(request: () => Promise<ApiResult<T>>, accept: (data: T) => void) {
    setError(null);
    setNotice(null);
    setBusy(true);
    const result = await request();
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) accept(result.data);
    else setError(result.error.message);
  }

  const queries = updated ?? (state.status === "success" ? state.data.queries : []);
  const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const shown = queries.filter(({ name }) =>
    words.every((word) => name.toLowerCase().includes(word)),
  );
  const problem =
    tab.text.length > SQL_MAX_TEXT_CHARS
      ? `Save up to ${SQL_MAX_TEXT_CHARS.toLocaleString("en-US")} characters per query.`
      : tab.text.trim() === ""
        ? "Enter SQL in the current tab to save it."
        : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === "" || problem || busy || state.status !== "success") return;
    void perform(
      () => saveQuery(connectionId, { name, text: tab.text }),
      ({ queries }) => {
        setUpdated(queries);
        setName("");
        setSearch("");
        setNotice("Query saved.");
      },
    );
  }

  function rename(
    event: FormEvent<HTMLFormElement>,
    action: Extract<RowAction, { kind: "rename" }>,
  ) {
    event.preventDefault();
    if (!action.name.trim() || busy) return;
    void perform(
      () => editSavedQuery(connectionId, action.id, { name: action.name }),
      ({ queries }) => {
        setUpdated(queries);
        setRowAction(null);
        setNotice("Query renamed.");
      },
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Saved queries</DialogTitle>
        <DialogDescription>
          {persistent
            ? "Queries you save here are stored on this machine for this saved connection."
            : "Queries you save here stay available until this connection closes."}{" "}
          Save only SQL you want to keep, including any values typed into it.
        </DialogDescription>
      </DialogHeader>
      <form
        onSubmit={submit}
        className="flex flex-wrap items-end gap-2"
        aria-label="Save current query"
      >
        <label className="flex min-w-44 flex-1 flex-col gap-1.5 text-sm">
          Query name
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_SAVED_QUERY_NAME_CHARS}
            autoComplete="off"
          />
        </label>
        <Button
          type="submit"
          className="max-sm:w-full"
          disabled={busy || state.status !== "success" || !name.trim() || problem !== null}
        >
          <Bookmark aria-hidden="true" />
          Save current query
        </Button>
        {problem ? <p className="basis-full text-xs text-muted-foreground">{problem}</p> : null}
      </form>

      <div aria-live="polite" className="text-sm">
        {notice ? <p>{notice}</p> : null}
        {state.status === "loading" ? <p>Loading saved queries…</p> : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {state.status === "error" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {state.error.message}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            Retry
          </Button>
        </div>
      ) : null}
      {state.status === "success" && queries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No saved queries for this connection yet.</p>
      ) : null}
      {queries.length > 0 ? (
        <>
          <label className="flex flex-col gap-1.5 text-sm">
            Search saved queries
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name"
            />
          </label>
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No saved query matches.</p>
          ) : null}
          <ul aria-label="Queries" className="divide-y border-y">
            {shown.map((query) => (
              <li key={query.id} className="space-y-2 py-2">
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                  <span className="min-w-0 flex-1 wrap-anywhere text-sm">{query.name}</span>
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      aria-label={`Open ${query.name}`}
                      onClick={() =>
                        void perform(
                          () => getSavedQuery(connectionId, query.id),
                          (saved) => setError(onOpen(saved)),
                        )
                      }
                    >
                      <SquarePlus aria-hidden="true" />
                      Open
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Rename ${query.name}`}
                      onClick={() =>
                        setRowAction({ kind: "rename", id: query.id, name: query.name })
                      }
                    >
                      <Pencil aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy || problem !== null}
                      aria-label={`Replace SQL for ${query.name}`}
                      title="Replace saved SQL with the current tab"
                      onClick={() => setRowAction({ kind: "replace", id: query.id })}
                    >
                      <Save aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Delete ${query.name}`}
                      onClick={() => setRowAction({ kind: "remove", id: query.id })}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                {rowAction?.id === query.id && rowAction.kind === "rename" ? (
                  <form
                    className="flex flex-wrap gap-2"
                    aria-label={`Rename ${query.name}`}
                    onSubmit={(event) => rename(event, rowAction)}
                  >
                    <Input
                      className="w-auto flex-1"
                      aria-label="New query name"
                      autoFocus
                      value={rowAction.name}
                      maxLength={MAX_SAVED_QUERY_NAME_CHARS}
                      onChange={(event) => setRowAction({ ...rowAction, name: event.target.value })}
                    />
                    <Button type="submit" size="sm" disabled={busy || !rowAction.name.trim()}>
                      Rename
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setRowAction(null)}
                    >
                      Cancel
                    </Button>
                  </form>
                ) : null}
                {rowAction?.id === query.id && rowAction.kind === "replace" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm wrap-anywhere">
                      Replace the saved SQL with the current tab?
                    </span>
                    <Button
                      size="sm"
                      disabled={busy || problem !== null}
                      onClick={() =>
                        void perform(
                          () => editSavedQuery(connectionId, query.id, { text: tab.text }),
                          ({ queries }) => {
                            setUpdated(queries);
                            setRowAction(null);
                            setNotice("Saved SQL replaced.");
                          },
                        )
                      }
                    >
                      Replace SQL
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setRowAction(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : null}
                {rowAction?.id === query.id && rowAction.kind === "remove" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm wrap-anywhere">
                      Remove “{query.name}” from this library?
                    </span>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          () => deleteSavedQuery(connectionId, query.id),
                          ({ queries }) => {
                            setUpdated(queries);
                            setRowAction(null);
                            setNotice("Query removed.");
                          },
                        )
                      }
                    >
                      Remove
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setRowAction(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
