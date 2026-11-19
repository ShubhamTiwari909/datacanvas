/**
 * The SQL view (1.6.0, decisions 141 and 142): an editor above, the result below. One
 * statement is run at a time, read-only, with a limit on rows and time. A refused statement
 * is shown with the database's own sentence and marked in the text.
 *
 * It needs viewing table data to be on for the connection (a result is rows); until then it
 * says so and offers to switch it on.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import dynamic from "next/dynamic";
import {
  AlertTriangle,
  Copy,
  ChevronDown,
  Database,
  Download,
  FolderOpen,
  History,
  Share2,
  Pencil,
  Play,
  Plus,
  Square,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/states/empty-state";
import { LoadingState } from "@/components/states/loading-state";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  MAX_TAB_NAME_CHARS,
  MAX_TABS,
  runningTab,
  tabText,
  useConnectionSql,
  useSqlStore,
  type ConnectionSql,
  type HistoryEntry,
  type SqlRunState,
} from "@/stores/sql-store";
import { useConnectionWrites, useWritesStore } from "@/stores/writes-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  checkFileSize,
  checkFileText,
  exportFileName,
  normalizeText,
  sqlFileName,
  tabNameFromFile,
} from "./files";
import { ensureCatalog } from "./completion/catalog-cache";
import { csvFile, planText, toCsv, toJson, toTsv } from "./export";
import { HistoryDialog } from "./history-dialog";
import { sqlRoleNotice } from "./role-notice";
import { ResultGrid } from "./result-grid";
import type { EditorHandle } from "./sql-editor";
import {
  elapsedText,
  failureTitle,
  lineColumn,
  nameFromStatement,
  resultSummary,
  ROW_LIMITS,
  startsWithExplain,
} from "./result-text";

// Monaco is big: it is fetched when this view opens, never with the first page.
const SqlEditor = dynamic(() => import("./sql-editor"), {
  ssr: false,
  loading: () => <LoadingState label="Loading the editor…" />,
});

export function SqlView({ connectionId }: { connectionId: string }) {
  const connection = useWorkspaceStore((s) => s.connections.find((c) => c.id === connectionId));
  const setDataAccess = useWorkspaceStore((s) => s.setDataAccess);

  if (!connection) return null;
  if (!connection.dataAccess) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <EmptyState
          icon={Database}
          title="Table data is switched off"
          description="Running SQL shows rows, so it needs viewing table data to be on for this connection."
        >
          <Button type="button" onClick={() => void setDataAccess(connectionId, true)}>
            Switch on table data
          </Button>
        </EmptyState>
      </div>
    );
  }
  return <Editor connectionId={connectionId} />;
}

function Editor({ connectionId }: { connectionId: string }) {
  const sql = useConnectionSql(connectionId);
  const active = sql.tabs.find((t) => t.id === sql.activeId) ?? sql.tabs[0]!;
  const store = useSqlStore.getState;
  const running = runningTab(sql);
  const [message, setMessage] = useState<string | null>(null);
  const openInput = useRef<HTMLInputElement>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // What the connected role can do outside the database matters most here: say so for a risky one.
  const role = useConnectionWrites(connectionId).role;
  useEffect(() => {
    if (!role) void useWritesStore.getState().loadRole(connectionId);
  }, [connectionId, role]);
  const roleNotice = role ? sqlRoleNotice(role.role) : null;

  // Read the database's names once, so completion is ready when the person starts typing.
  useEffect(() => {
    void ensureCatalog(connectionId);
  }, [connectionId]);
  const getCatalog = useCallback(() => ensureCatalog(connectionId), [connectionId]);
  const textFor = useCallback((tabId: string) => tabText(connectionId, tabId), [connectionId]);
  const openTabIds = useMemo(() => sql.tabs.map((t) => t.id), [sql.tabs]);

  // The database's position means something only while the text is as it was when it ran.
  const state = active.state;
  const failureOffset =
    state.kind === "failure" && state.failure.position !== null && state.docText === active.text
      ? state.base + state.failure.position
      : null;
  const failureMessage = state.kind === "failure" ? state.failure.message : "";
  const marker = useMemo(
    () => (failureOffset === null ? null : { offset: failureOffset, message: failureMessage }),
    [failureOffset, failureMessage],
  );

  /** Run the selection (else everything), with `EXPLAIN ` in front for a plan. */
  function runNow(prefix = "") {
    const part = handleRef.current?.runText() ?? { text: active.text, base: 0 };
    const sentPrefix = prefix !== "" && !startsWithExplain(part.text) ? prefix : "";
    void store().run(connectionId, active.id, part.text, part.base, sentPrefix);
  }

  /** A statement from the history, in a new tab, and run when asked (if nothing else is running). */
  function reopen(entry: HistoryEntry, thenRun: boolean) {
    setHistoryOpen(false);
    const id = store().newTab(connectionId, {
      name: nameFromStatement(entry.text),
      text: entry.text,
    });
    if (id === null)
      return setMessage(`At most ${MAX_TABS} query tabs can be open. Close one first.`);
    setMessage(null);
    const now = useSqlStore.getState().byConnection[connectionId];
    if (thenRun && now && !runningTab(now)) void store().run(connectionId, id, entry.text, 0);
  }

  function save() {
    // A download made in the browser from text already in hand: nothing is stored.
    const url = URL.createObjectURL(new Blob([active.text], { type: "application/sql" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = sqlFileName(active.name);
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function openFile(file: File | undefined) {
    if (!file) return;
    setMessage(null);
    const size = checkFileSize(file.size);
    if (!size.ok) return setMessage(size.message);
    const text = normalizeText(await file.text());
    const checked = checkFileText(text);
    if (!checked.ok) return setMessage(checked.message);
    const id = store().newTab(connectionId, { name: tabNameFromFile(file.name), text });
    if (id === null) setMessage(`At most ${MAX_TABS} query tabs can be open. Close one first.`);
  }

  return (
    <div className="flex h-full min-h-[28rem] flex-col">
      {roleNotice ? (
        <p
          role="note"
          aria-label="About this role"
          className="flex items-start gap-2 border-b bg-amber-50 px-3 py-1.5 text-xs text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {roleNotice}
        </p>
      ) : null}
      <QueryTabs connectionId={connectionId} sql={sql} />
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button type="button" size="sm" disabled={running !== undefined} onClick={() => runNow()}>
          <Play aria-hidden="true" />
          Run
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="outline" disabled={running !== undefined}>
              Explain
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-72">
            <DropdownMenuItem onSelect={() => runNow("EXPLAIN ")}>
              <span className="flex flex-col">
                <span>Explain</span>
                <span className="text-xs opacity-80">
                  Shows the plan. The statement is not run.
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => runNow("EXPLAIN (ANALYZE, BUFFERS) ")}>
              <span className="flex flex-col">
                <span>Explain analyze</span>
                <span className="text-xs opacity-80">
                  Runs the statement, and shows the plan with the real times.
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {running ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => store().cancel(connectionId)}
            >
              <Square aria-hidden="true" />
              Cancel
            </Button>
            {running.id !== active.id ? (
              <span className="text-xs text-muted-foreground">{running.name} is running</span>
            ) : null}
          </>
        ) : null}
        <label className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          Row limit
          <select
            aria-label="Row limit"
            value={active.maxRows}
            disabled={running !== undefined}
            onChange={(event) =>
              store().setMaxRows(connectionId, active.id, Number(event.target.value))
            }
            className="h-7 rounded-md border bg-background px-1.5 text-xs text-foreground"
          >
            {ROW_LIMITS.map((limit) => (
              <option key={limit} value={limit}>
                {new Intl.NumberFormat("en").format(limit)}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-1">
          <Tip label="Statements run on this connection">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Query history"
              onClick={() => setHistoryOpen(true)}
            >
              <History aria-hidden="true" />
            </Button>
          </Tip>
          <Tip label="Duplicate this tab">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Duplicate query tab"
              onClick={() => store().duplicateTab(connectionId, active.id)}
            >
              <Copy aria-hidden="true" />
            </Button>
          </Tip>
          <Tip label="Save this tab as a .sql file">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Save query as .sql"
              onClick={save}
            >
              <Download aria-hidden="true" />
            </Button>
          </Tip>
          <Tip label="Open a .sql file in a new tab">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Open .sql file"
              onClick={() => openInput.current?.click()}
            >
              <FolderOpen aria-hidden="true" />
            </Button>
          </Tip>
          <input
            ref={openInput}
            type="file"
            accept=".sql,.txt,.pgsql,text/plain,application/sql"
            aria-label="Open a .sql file"
            className="hidden"
            onChange={(event) => {
              void openFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
      </div>
      <p className="border-b px-3 py-1 text-xs text-muted-foreground">
        Read-only. <kbd className="font-mono">Ctrl</kbd>/<kbd className="font-mono">⌘</kbd>{" "}
        <kbd className="font-mono">Enter</kbd> runs the selection, or everything. Press{" "}
        <kbd className="font-mono">Esc</kbd> then <kbd className="font-mono">Tab</kbd> to leave the
        editor. Queries are kept only until you close this page: save a tab to keep it.
      </p>
      {message ? (
        <p role="alert" className="border-b px-3 py-1.5 text-xs text-destructive">
          {message}
        </p>
      ) : null}
      <div className="h-[40%] min-h-40 border-b">
        <SqlEditor
          tabId={active.id}
          textFor={textFor}
          openTabIds={openTabIds}
          handle={handleRef}
          onChange={(tabId, value) => store().setText(connectionId, tabId, value)}
          onRun={(tabId, runText, base) => void store().run(connectionId, tabId, runText, base)}
          marker={marker}
          getCatalog={getCatalog}
        />
      </div>
      <section aria-label="Result" className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <Result state={active.state} tabName={active.name} />
      </section>
      <HistoryDialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        history={sql.history}
        canRun={running === undefined}
        onOpen={reopen}
        onClear={() => store().clearHistory(connectionId)}
      />
    </div>
  );
}

/** The query tabs: one tab stop, arrows move between tabs, a double click or Rename renames. */
function QueryTabs({ connectionId, sql }: { connectionId: string; sql: ConnectionSql }) {
  const store = useSqlStore.getState;
  const [renaming, setRenaming] = useState<string | null>(null);
  const atLimit = sql.tabs.length >= MAX_TABS;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (renaming) return;
    if (event.key === "Delete") {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[role=tab]");
      const id = target?.id.replace(/^sql-tab-/, "");
      if (id) {
        event.preventDefault();
        store().closeTab(connectionId, id);
      }
      return;
    }
    const at = sql.tabs.findIndex((t) => t.id === sql.activeId);
    const next =
      event.key === "ArrowRight"
        ? sql.tabs[(at + 1) % sql.tabs.length]
        : event.key === "ArrowLeft"
          ? sql.tabs[(at - 1 + sql.tabs.length) % sql.tabs.length]
          : event.key === "Home"
            ? sql.tabs[0]
            : event.key === "End"
              ? sql.tabs.at(-1)
              : undefined;
    if (!next) return;
    event.preventDefault();
    store().selectTab(connectionId, next.id);
    requestAnimationFrame(() =>
      document.getElementById(`sql-tab-${next.id}`)?.focus({ preventScroll: false }),
    );
  }

  return (
    <div className="flex items-center gap-1 border-b px-2 py-1">
      <div
        role="tablist"
        aria-label="Query tabs"
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:thin]"
      >
        {sql.tabs.map((tab) => {
          const selected = tab.id === sql.activeId;
          const busy = tab.state.kind === "running";
          return (
            <div
              key={tab.id}
              role="presentation"
              className={cn(
                "group flex shrink-0 items-center rounded-md border border-transparent",
                selected ? "bg-secondary" : "hover:bg-muted",
              )}
            >
              {renaming === tab.id ? (
                <RenameInput
                  initial={tab.name}
                  onDone={(name) => {
                    if (name !== null) store().renameTab(connectionId, tab.id, name);
                    setRenaming(null);
                  }}
                />
              ) : (
                <button
                  id={`sql-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => store().selectTab(connectionId, tab.id)}
                  onDoubleClick={() => setRenaming(tab.id)}
                  className="flex h-7 max-w-48 items-center gap-1.5 rounded-md px-2 text-[0.8rem] font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {busy ? (
                    <span
                      role="img"
                      aria-label="running"
                      className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
                    />
                  ) : null}
                  <span className="truncate">{tab.name}</span>
                </button>
              )}
              {/* For the mouse only. A tab list holds tabs and nothing else, so the keyboard
                  closes the tab with Delete, or with "Close query tab" in the toolbar. */}
              <button
                type="button"
                aria-hidden="true"
                tabIndex={-1}
                onClick={() => store().closeTab(connectionId, tab.id)}
                className="mr-1 flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:bg-background hover:text-foreground"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <Tip label={atLimit ? `At most ${MAX_TABS} tabs` : "New query tab"}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="New query tab"
          aria-disabled={atLimit}
          onClick={() => {
            if (!atLimit) store().newTab(connectionId);
          }}
        >
          <Plus aria-hidden="true" />
        </Button>
      </Tip>
      <Tip label="Close this tab">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Close query tab"
          onClick={() => store().closeTab(connectionId, sql.activeId)}
        >
          <X aria-hidden="true" />
        </Button>
      </Tip>
      <Tip label="Rename this tab">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Rename query tab"
          onClick={() => setRenaming(sql.activeId)}
        >
          <Pencil aria-hidden="true" />
        </Button>
      </Tip>
    </div>
  );
}

function RenameInput({
  initial,
  onDone,
}: {
  initial: string;
  /** The new name, or null when the person gave up. */
  onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      autoFocus
      aria-label="Tab name"
      value={value}
      maxLength={MAX_TAB_NAME_CHARS}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.target.select()}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(value);
        else if (event.key === "Escape") finish(null);
      }}
      className="mx-1 h-6 w-40 rounded border bg-background px-1.5 text-[0.8rem] outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}

function Result({ state, tabName }: { state: SqlRunState; tabName: string }) {
  if (state.kind === "idle") {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Type a statement above and run it. Only SELECT, WITH, VALUES, TABLE, EXPLAIN and SHOW are
        accepted, and nothing is changed.
      </p>
    );
  }
  if (state.kind === "running") return <Running startedAt={state.startedAt} />;
  if (state.kind === "cancelled") {
    return (
      <div role="status" className="p-4 text-sm text-muted-foreground">
        The statement was cancelled.
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <p>{state.message}</p>
      </div>
    );
  }
  if (state.kind === "failure") {
    const { failure, ranText } = state;
    const where = failure.position !== null ? lineColumn(ranText, failure.position) : null;
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-medium">{failureTitle(failure)}</p>
          <p className="mt-1 font-mono text-xs break-words whitespace-pre-wrap">
            {failure.message}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {failure.code}
            {where ? ` · line ${where.line}, column ${where.column}` : ""}
          </p>
        </div>
      </div>
    );
  }
  const { result } = state;
  // An explain is one column of text lines: shown as it is printed, not as a table.
  const isPlan = result.command === "EXPLAIN" && result.columns.length === 1;
  if (result.columns.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        The statement ran and returned no columns. {resultSummary(result).at(-1)}.
      </p>
    );
  }
  return (
    <>
      <div className="min-h-0 flex-1">
        {result.rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No rows. Columns:{" "}
            <span className="font-mono">{result.columns.map((c) => c.name).join(", ")}</span>
          </p>
        ) : isPlan ? (
          <pre
            tabIndex={0}
            aria-label="Query plan"
            className="h-full overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs whitespace-pre"
          >
            {planText(result.rows)}
          </pre>
        ) : (
          <ResultGrid result={result} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">{resultSummary(result).join(" · ")}</p>
        {result.rows.length > 0 ? (
          <ExportMenu result={result} tabName={tabName} plan={isPlan} />
        ) : null}
      </div>
    </>
  );
}

function Running({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 200);
    return () => clearInterval(timer);
  }, [startedAt]);
  return (
    <div role="status" className="p-4 text-sm text-muted-foreground">
      Running… {elapsedText(elapsed)}
    </div>
  );
}

/** Copy the rows as TSV, CSV or JSON, or save them as a CSV file: exactly what the grid holds. */
function ExportMenu({
  result,
  tabName,
  plan,
}: {
  result: Extract<SqlRunState, { kind: "result" }>["result"];
  tabName: string;
  plan: boolean;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  function copy(label: string, text: string) {
    // The clipboard can be unavailable (permissions, insecure context): then nothing happens.
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(label);
        window.setTimeout(() => setCopied(null), 1500);
      })
      .catch(() => {});
  }

  function download() {
    const url = URL.createObjectURL(
      new Blob([csvFile(result.columns, result.rows)], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName(tabName, "csv");
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="xs" variant="outline">
          <Share2 aria-hidden="true" />
          {copied ? `Copied as ${copied}` : "Export"}
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {plan ? (
          <DropdownMenuItem onSelect={() => copy("text", planText(result.rows))}>
            Copy the plan
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => copy("TSV", toTsv(result.columns, result.rows))}>
          Copy as TSV
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => copy("CSV", toCsv(result.columns, result.rows))}>
          Copy as CSV
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => copy("JSON", toJson(result.columns, result.rows))}>
          Copy as JSON
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={download}>
          <Download aria-hidden="true" />
          Download CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
