/**
 * The JSON editor (`docs/advanced-data-workspace-plan.md`, section 5): a window with the document in
 * an editor (colours, matching brackets, the place where it stops being JSON), Format and Minify
 * that keep every number and string as written, a tree for a large document, and the changes
 * against the value that was loaded.
 *
 * It writes nothing. "Use this value" hands the text back to the form it was opened from; the form
 * previews and applies it like any other value, with the check that the row did not change meanwhile.
 * A value over what a change may carry (100,000 characters) can be read here but not edited.
 */
"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { WRITE_MAX_CHANGE_VALUE_CHARS } from "@datacanvas/shared-types";
import type { CellRead } from "@datacanvas/database-core";
import { CopyButton } from "@/components/copy-button";
import { ErrorState } from "@/components/states/error-state";
import { LoadingState } from "@/components/states/loading-state";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BLUR_CLASSES, useBlurStore } from "@/features/data/blur-store";
import type { ApiResult } from "@/lib/api-client";
import { useAsyncData } from "@/lib/use-async-data";
import { cn } from "@/lib/utils";
import { countChanges, diffDocuments } from "./json-diff";
import { buildJsonTree, pathText, type JsonTree, type TreeNode } from "./json-tree";
import { checkJson, formatJson } from "./json-text";

const JsonCodeEditor = dynamic(() => import("./json-code-editor"), {
  ssr: false,
  loading: () => <LoadingState label="Loading the editor…" />,
});

const number = new Intl.NumberFormat();

export interface JsonEditorDialogProps {
  open: boolean;
  onClose: () => void;
  /** The column's name, for the title. */
  column: string;
  /** The text to start from, when it is known whole. Ignored when `load` is given. */
  text?: string;
  /** Read the whole value first (a value that a page of rows cut short). Called once, when the window opens. */
  load?: () => Promise<ApiResult<CellRead>>;
  /** The value as it was loaded, for the Changes view; absent when there is nothing to compare with. */
  original?: string | null;
  /** True when the value can be looked at but not changed. */
  readOnly?: boolean;
  /**
   * The text the person chose to use, and the value as it was read (null when there was none), so a form
   * can compare against exactly that. Absent in a window that only shows a value.
   */
  onApply?: (text: string, original: string | null) => void;
}

export function JsonEditorDialog(props: JsonEditorDialogProps) {
  const { open, onClose, column } = props;
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        size="builder"
        // The window sits inside a form in the row editor: keys typed here are not the form's keys
        // (Ctrl or Cmd plus Enter there previews the change).
        onKeyDown={(event) => event.stopPropagation()}
      >
        {open ? <Body {...props} key={column} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Header({
  column,
  readOnly,
  canApply,
}: {
  column: string;
  readOnly: boolean;
  canApply: boolean;
}) {
  return (
    <DialogHeader>
      <DialogTitle>
        <span className="font-mono">{column}</span> as JSON
      </DialogTitle>
      <DialogDescription>
        {readOnly
          ? "This value can be read here but not changed."
          : canApply
            ? "Edit the document. Nothing is written until you preview and apply the change."
            : "Read the document as text, or as a tree."}
      </DialogDescription>
    </DialogHeader>
  );
}

function Body(props: JsonEditorDialogProps) {
  const { load, text, column, onClose } = props;
  if (!load) {
    return <Editor {...props} initial={text ?? ""} oversized={false} />;
  }
  return <Loader {...props} load={load} key={column} onClose={onClose} />;
}

function Loader(props: JsonEditorDialogProps & { load: () => Promise<ApiResult<CellRead>> }) {
  const { load, column, onClose } = props;
  const { state, reload } = useAsyncData(load, column);
  if (state.status === "loading") {
    return (
      <>
        <Header column={column} readOnly={false} canApply={false} />
        <LoadingState label="Reading the whole value…" />
      </>
    );
  }
  if (state.status === "error") {
    return (
      <>
        <Header column={column} readOnly={false} canApply={false} />
        <ErrorState
          title="The value could not be read"
          message={state.error.message}
          onRetry={reload}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }
  const cell = state.data;
  if (cell.tooLarge) {
    return (
      <>
        <Header column={column} readOnly canApply={false} />
        <p role="status" className="text-sm text-muted-foreground">
          This document is larger than 1 million characters, so it is not read here. Use the SQL tab
          to look at parts of it.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }
  return (
    <Editor
      {...props}
      initial={cell.value ?? ""}
      original={props.original === undefined ? cell.value : props.original}
      oversized={false}
    />
  );
}

type View = "editor" | "tree" | "changes";

function Editor({
  column,
  initial,
  original,
  readOnly: readOnlyProp = false,
  onApply,
  onClose,
}: JsonEditorDialogProps & { initial: string; oversized: boolean }) {
  const blurred = useBlurStore((s) => s.blurred);
  const [text, setText] = useState(initial);
  const [view, setView] = useState<View>("editor");
  // A value a change cannot carry can be read here but not edited.
  const tooBigToEdit = initial.length > WRITE_MAX_CHANGE_VALUE_CHARS;
  const readOnly = readOnlyProp || tooBigToEdit || !onApply;
  const checked = useMemo(() => checkJson(text), [text]);
  const error = checked.ok ? null : checked.error;
  const overLimit = text.length > WRITE_MAX_CHANGE_VALUE_CHARS;
  const hasOriginal = original !== undefined && original !== null;
  // What "changed" means: against the loaded value if there is one, else against where the window started.
  const changed = text !== (hasOriginal ? original : initial);
  const tree = useMemo<JsonTree | null>(
    () => (view === "tree" && checked.ok ? buildJsonTree(text) : null),
    [view, checked.ok, text],
  );
  const changes = useMemo(
    () => (view === "changes" && hasOriginal ? diffDocuments(original, text) : null),
    [view, hasOriginal, original, text],
  );

  const status = error
    ? `Line ${error.line}, column ${error.column}: ${error.message}`
    : overLimit
      ? `This is longer than ${number.format(WRITE_MAX_CHANGE_VALUE_CHARS)} characters, which is the most a change can carry.`
      : `Valid JSON, ${number.format(text.length)} characters.`;

  const tabs: Array<[View, string]> = [
    ["editor", "Editor"],
    ["tree", "Tree"],
    ...(hasOriginal ? ([["changes", "Changes"]] as Array<[View, string]>) : []),
  ];

  return (
    <>
      <Header column={column} readOnly={readOnly && !!onApply} canApply={!!onApply} />
      {tooBigToEdit ? (
        <p role="note" className="text-sm text-muted-foreground">
          This document is longer than {number.format(WRITE_MAX_CHANGE_VALUE_CHARS)} characters,
          which is the most a change can carry, so it is read-only here.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="View" className="flex gap-1.5">
          {tabs.map(([id, label]) => (
            <Button
              key={id}
              type="button"
              size="sm"
              variant="outline"
              aria-pressed={view === id}
              onClick={() => setView(id)}
              className="aria-pressed:border-transparent aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90 dark:aria-pressed:bg-primary dark:aria-pressed:text-primary-foreground"
            >
              {label}
              {id === "changes" && changed ? " •" : ""}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={readOnly || !checked.ok}
            onClick={() => {
              const next = formatJson(text, 2);
              if (next !== null) setText(next);
            }}
          >
            Format
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={readOnly || !checked.ok}
            onClick={() => {
              const next = formatJson(text, 0);
              if (next !== null) setText(next);
            }}
          >
            Minify
          </Button>
          {changed ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={readOnly}
              onClick={() => setText(hasOriginal ? original : initial)}
            >
              Reset
            </Button>
          ) : null}
          <CopyButton text={text} label={`Copy the JSON of ${column}`} />
        </div>
      </div>

      <div className={cn("min-h-64", blurred && BLUR_CLASSES)}>
        {view === "editor" ? (
          <div className="h-[45vh] min-h-64 overflow-hidden rounded-md border">
            <JsonCodeEditor
              value={text}
              onChange={setText}
              readOnly={readOnly}
              error={error}
              ariaLabel={`JSON of ${column}`}
            />
          </div>
        ) : null}
        {view === "tree" ? <TreeView tree={tree} error={error} /> : null}
        {view === "changes" ? <ChangesView lines={changes} unchanged={!changed} /> : null}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {onApply && !readOnly ? "Cancel" : "Close"}
        </Button>
        {onApply && !readOnly ? (
          <Button
            type="button"
            disabled={!checked.ok || overLimit || !changed}
            onClick={() => onApply(text, hasOriginal ? original : null)}
          >
            Use this value
          </Button>
        ) : null}
        <p
          role="status"
          className={cn(
            "self-center text-xs sm:order-first sm:mr-auto",
            error || overLimit ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {status}
        </p>
      </DialogFooter>
    </>
  );
}

// ------------------------------------------------------------------- tree ---

function TreeView({ tree, error }: { tree: JsonTree | null; error: { message: string } | null }) {
  const [selected, setSelected] = useState<Array<string | number>>([]);
  if (error || !tree) {
    return (
      <p role="note" className="rounded-md border p-4 text-sm text-muted-foreground">
        The tree shows a document that is valid JSON. Fix the error in the editor first.
      </p>
    );
  }
  const path = pathText(selected);
  return (
    <div className="flex flex-col gap-2">
      <div
        className="max-h-[40vh] min-h-48 overflow-auto rounded-md border p-2"
        tabIndex={0}
        aria-label="Tree of the document"
      >
        <ul className="font-mono text-xs">
          <TreeItem
            node={tree.root}
            path={[]}
            depth={0}
            selected={selected}
            onSelect={setSelected}
          />
        </ul>
        {tree.truncated ? (
          <p role="note" className="mt-2 text-xs text-muted-foreground">
            The document is large: only the first part is shown here. Use the editor to see all of
            it.
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Path</span>
        <code className="min-w-0 flex-1 truncate font-mono" title={path}>
          {path}
        </code>
        <CopyButton text={path} label="Copy the path" />
      </div>
    </div>
  );
}

function TreeItem({
  node,
  path,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode;
  path: Array<string | number>;
  depth: number;
  selected: Array<string | number>;
  onSelect: (path: Array<string | number>) => void;
}) {
  // The top levels start open; deeper ones start closed, so a large document opens quickly.
  const [open, setOpen] = useState(depth < 2);
  const here = node.step === null ? path : [...path, node.step];
  const isContainer = node.kind === "object" || node.kind === "array";
  const isSelected = selected.length === here.length && selected.every((s, i) => s === here[i]);
  const label = node.step === null ? "(document)" : String(node.step);
  return (
    <li>
      <div className="flex items-center gap-1 py-0.5" style={{ paddingLeft: `${depth * 0.9}rem` }}>
        {isContainer && node.children.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </Button>
        ) : (
          <span className="inline-block size-6 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          aria-pressed={isSelected}
          onClick={() => onSelect(here)}
          className={cn(
            "min-w-0 truncate rounded-sm px-1 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            isSelected && "bg-muted font-semibold",
          )}
        >
          <span>
            {node.step === null
              ? ""
              : typeof node.step === "number"
                ? `${node.step}: `
                : `${node.step}: `}
          </span>
          <span className={isContainer ? "text-muted-foreground" : undefined}>{node.preview}</span>
        </button>
      </div>
      {isContainer && open && node.children.length > 0 ? (
        <ul>
          {node.children.map((child, i) => (
            <TreeItem
              key={`${String(child.step)}-${i}`}
              node={child}
              path={here}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------- changes ---

function ChangesView({
  lines,
  unchanged,
}: {
  lines: ReturnType<typeof diffDocuments>;
  unchanged: boolean;
}) {
  if (unchanged) {
    return (
      <p role="note" className="rounded-md border p-4 text-sm text-muted-foreground">
        Nothing has changed from the value that was loaded.
      </p>
    );
  }
  if (!lines) {
    return (
      <p role="note" className="rounded-md border p-4 text-sm text-muted-foreground">
        The document is too long to compare line by line.
      </p>
    );
  }
  const { added, removed } = countChanges(lines);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {added} {added === 1 ? "line" : "lines"} added, {removed} {removed === 1 ? "line" : "lines"}{" "}
        removed. Both sides are laid out the same way first, so spacing alone is not a change.
      </p>
      <pre
        tabIndex={0}
        aria-label="Changes against the loaded value"
        className="max-h-[40vh] min-h-48 overflow-auto rounded-md border p-2 font-mono text-xs"
      >
        {lines.map((line, i) => (
          <span
            key={i}
            className={cn(
              "block whitespace-pre-wrap",
              line.kind === "added" && "bg-emerald-500/15",
              line.kind === "removed" && "bg-destructive/15",
            )}
          >
            <span aria-hidden="true">
              {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
            </span>
            {line.kind !== "same" ? (
              <span className="sr-only">{line.kind === "added" ? "Added: " : "Removed: "}</span>
            ) : null}
            {line.text}
          </span>
        ))}
      </pre>
    </div>
  );
}
