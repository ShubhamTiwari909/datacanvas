/**
 * The whole value of a text cell that a page cut short, to read and, when a change can carry it, to edit
 * (`docs/write-side-v2-plan.md`, section 7). It reads the value from the database when it opens (the server says how
 * long it is and whether it can be edited), shows it in a text field, and hands the new text back with the value it
 * was read as. It writes nothing: the grid keeps the change as a pending cell, reviewed and applied like any other.
 */
"use client";

import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { BLUR_CLASSES, useBlurStore } from "@/features/data/blur-store";
import type { ApiResult } from "@/lib/api-client";
import { useAsyncData } from "@/lib/use-async-data";
import { cn } from "@/lib/utils";
import {
  CUT_TEXT_TOO_LARGE_TEXT,
  cutTextTooLongText,
  hasCarriageReturn,
  isSameText,
  newTextProblem,
  wholeValueOf,
} from "./cut-text";
import { CARRIAGE_RETURN_TEXT } from "./line-endings";

const number = new Intl.NumberFormat();

export interface CutTextDialogProps {
  open: boolean;
  onClose: () => void;
  column: string;
  /** Read the whole value (called once, when the window opens). */
  load: () => Promise<ApiResult<CellRead>>;
  /** A change already kept for this cell: the window starts from it and keeps its original, and reads nothing. */
  pending?: { before: string | null; after: string | null } | null;
  /** The text chosen, and the value as it was read: what the change is checked against when it is applied. */
  onUse: (text: string, before: string | null) => void;
}

export function CutTextDialog(props: CutTextDialogProps) {
  const { open, onClose, column } = props;
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent size="builder" onKeyDown={(event) => event.stopPropagation()}>
        {open ? <Body {...props} key={column} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Header({ column, note }: { column: string; note: string }) {
  return (
    <DialogHeader>
      <DialogTitle>
        Edit <span className="font-mono">{column}</span>
      </DialogTitle>
      <DialogDescription>{note}</DialogDescription>
    </DialogHeader>
  );
}

function CloseFooter({ onClose }: { onClose: () => void }) {
  return (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onClose}>
        Close
      </Button>
    </DialogFooter>
  );
}

function Body(props: CutTextDialogProps) {
  const { column, onClose, load, pending, onUse } = props;
  if (pending) {
    if (hasCarriageReturn(pending.before)) {
      return (
        <ReadOnly
          column={column}
          whole={{ text: pending.before ?? "" }}
          reason={CARRIAGE_RETURN_TEXT}
          onClose={onClose}
        />
      );
    }
    return (
      <Editor
        column={column}
        initial={pending.after}
        original={pending.before}
        onClose={onClose}
        onUse={onUse}
      />
    );
  }
  return <Loader column={column} load={load} onClose={onClose} onUse={onUse} />;
}

function Loader({
  column,
  load,
  onClose,
  onUse,
}: Pick<CutTextDialogProps, "column" | "load" | "onClose" | "onUse">) {
  const { state, reload } = useAsyncData(load, column);
  if (state.status === "loading") {
    return (
      <>
        <Header column={column} note="Reading the whole value from the database." />
        <LoadingState label="Reading the whole value…" />
      </>
    );
  }
  if (state.status === "error") {
    return (
      <>
        <Header column={column} note="The whole value could not be read." />
        <ErrorState
          title="The value could not be read"
          message={state.error.message}
          onRetry={reload}
        />
        <CloseFooter onClose={onClose} />
      </>
    );
  }
  const whole = wholeValueOf(state.data);
  if (whole.kind === "too_large") {
    return (
      <>
        <Header column={column} note="This value cannot be edited here." />
        <p role="status" className="text-sm text-muted-foreground">
          {CUT_TEXT_TOO_LARGE_TEXT}
        </p>
        <CloseFooter onClose={onClose} />
      </>
    );
  }
  if (whole.kind === "read_only")
    return (
      <ReadOnly
        column={column}
        whole={whole}
        reason={cutTextTooLongText(whole.length)}
        onClose={onClose}
      />
    );
  if (hasCarriageReturn(whole.text)) {
    return (
      <ReadOnly
        column={column}
        whole={{ text: whole.text ?? "" }}
        reason={CARRIAGE_RETURN_TEXT}
        onClose={onClose}
      />
    );
  }
  return (
    <Editor
      column={column}
      initial={whole.text}
      original={whole.text}
      onClose={onClose}
      onUse={onUse}
    />
  );
}

function ReadOnly({
  column,
  whole,
  reason,
  onClose,
}: {
  column: string;
  whole: { text: string };
  /** Why it cannot be edited. */
  reason: string;
  onClose: () => void;
}) {
  const blurred = useBlurStore((s) => s.blurred);
  return (
    <>
      <Header column={column} note="This value can be read and copied here, but not edited." />
      <p role="status" className="text-sm text-muted-foreground">
        {reason}
      </p>
      <pre
        tabIndex={0}
        aria-label={`Whole value of ${column}`}
        className={cn(
          "max-h-[45vh] min-h-32 overflow-auto rounded-md bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap",
          blurred && BLUR_CLASSES,
        )}
      >
        {whole.text}
      </pre>
      <DialogFooter>
        <CopyButton text={whole.text} label={`Copy the whole value of ${column}`} />
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

function Editor({
  column,
  initial,
  original,
  onClose,
  onUse,
}: {
  column: string;
  /** What the field starts with: the value read, or the change already kept. NULL starts as an empty field. */
  initial: string | null;
  /** The value as it was read from the database. */
  original: string | null;
  onClose: () => void;
  onUse: (text: string, before: string | null) => void;
}) {
  const blurred = useBlurStore((s) => s.blurred);
  const [text, setText] = useState(initial ?? "");
  const problem = newTextProblem(text);
  // Nothing to keep until the text differs from where the window started (a kept change can be put back to the original).
  const unchanged = initial !== null && isSameText(initial, text);
  return (
    <>
      <Header
        column={column}
        note="Edit the whole value. Nothing is written until you review and apply the change."
      />
      <Textarea
        autoFocus
        aria-label={`New value of ${column}`}
        aria-invalid={problem !== null}
        aria-describedby={`${column}-cut-status`}
        rows={14}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className={cn("h-[45vh] max-h-[45vh] min-h-48 resize-y font-mono", blurred && BLUR_CLASSES)}
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={problem !== null || unchanged}
          onClick={() => onUse(text, original)}
        >
          Use this value
        </Button>
        <p
          id={`${column}-cut-status`}
          role="status"
          className={cn(
            "self-center text-xs sm:order-first sm:mr-auto",
            problem ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {problem ?? `${number.format(text.length)} characters.`}
        </p>
      </DialogFooter>
    </>
  );
}
