/**
 * The preview step every change goes through (decision 127): the server checks
 * the change and answers with the exact statement, its effect and its
 * warnings; the person reads them and applies. Apply sends only the preview's
 * id, so what runs is exactly what was shown. A destructive change needs a
 * tick before Apply is enabled.
 *
 * The "before and after" table is built in the browser from what the person
 * saw and typed; no value comes back from the server.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { Change } from "@datacanvas/database-core";
import type { ChangePreview, HistoryEntry } from "@datacanvas/shared-types";
import { CopyButton } from "@/components/copy-button";
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
import type { ApiFailure } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useWritesStore } from "@/stores/writes-store";
import { requestApply, requestPreview } from "./api";
import { shownText, type BeforeAfterRow } from "./row-edit";

export interface ChangeRequest {
  change: Change;
  /** The dialog's title, e.g. "Edit a row of public.users". */
  title: string;
  /** For row changes: what the person saw and what they asked for. */
  beforeAfter?: BeforeAfterRow[];
}

export interface AppliedResult {
  rowCount: number;
  entry: HistoryEntry;
}

type Step =
  | { kind: "previewing" }
  | { kind: "refused"; error: ApiFailure }
  | { kind: "ready"; preview: ChangePreview }
  | { kind: "applying"; preview: ChangePreview }
  | { kind: "failed"; preview: ChangePreview; error: ApiFailure };

export function ChangeDialog({
  connectionId,
  request,
  onClose,
  onApplied,
  onRowChanged,
}: {
  connectionId: string;
  request: ChangeRequest | null;
  onClose: () => void;
  onApplied: (result: AppliedResult, change: Change) => void;
  /** Offered when the row changed since it was loaded (reload the page of rows). */
  onRowChanged?: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  // The step and the tick belong to one request and attempt; anything else is a new preview.
  const [stored, setStored] = useState<{
    request: ChangeRequest;
    attempt: number;
    step: Step;
    read: boolean;
  } | null>(null);
  const current =
    stored && stored.request === request && stored.attempt === attempt ? stored : null;
  const step: Step = current?.step ?? { kind: "previewing" };
  const read = current?.read ?? false;
  const setStep = (next: Step) =>
    setStored((s) => (request ? { request, attempt, step: next, read: s?.read ?? false } : s));
  const setRead = (next: boolean) => setStored((s) => (s ? { ...s, read: next } : s));
  // Closing the dialog while the change is being applied cancels it: an import stops between its batches and
  // everything is rolled back; a single row is applied in one statement, too fast to stop.
  const applying = useRef<AbortController | null>(null);
  const close = () => {
    applying.current?.abort();
    applying.current = null;
    onClose();
  };
  const recordChange = useWritesStore((s) => s.recordChange);
  const loadHistory = useWritesStore((s) => s.loadHistory);
  const blurred = useBlurStore((s) => s.blurred);

  // A new request (or "Preview again") asks the server for a fresh preview.
  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    void requestPreview(connectionId, request.change).then((result) => {
      if (cancelled) return;
      setStored({
        request,
        attempt,
        read: false,
        step: result.ok
          ? { kind: "ready", preview: result.data }
          : { kind: "refused", error: result.error },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [connectionId, request, attempt]);

  const preview =
    step.kind === "ready" || step.kind === "applying" || step.kind === "failed"
      ? step.preview
      : null;

  async function apply(current: ChangePreview) {
    if (!request) return;
    setStep({ kind: "applying", preview: current });
    const abort = new AbortController();
    applying.current = abort;
    const result = await requestApply(connectionId, current.previewId, abort.signal);
    if (applying.current === abort) applying.current = null;
    // Cancelled by closing the dialog: nothing was kept, and there is nothing to say to a closed dialog.
    if (!result.ok && result.error.code === "aborted") return;
    if (!result.ok) {
      setStep({ kind: "failed", preview: current, error: result.error });
      // A failed change is in the session history too.
      void loadHistory(connectionId);
      return;
    }
    recordChange(connectionId, result.data.entry);
    onApplied(result.data, request.change);
  }

  const canApply = step.kind === "ready" && (!step.preview.destructive || read);

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>{request?.title ?? "Preview the change"}</DialogTitle>
          <DialogDescription>
            Check the statement before applying it. Changes are committed immediately and cannot be
            undone.
          </DialogDescription>
        </DialogHeader>

        {step.kind === "previewing" ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Checking the change…
          </p>
        ) : null}

        {step.kind === "refused" ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border p-3">
            <AlertTriangle className="mt-0.5 size-4 text-destructive" aria-hidden="true" />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">This change cannot be made</p>
              <p className="text-sm text-muted-foreground">{step.error.message}</p>
            </div>
          </div>
        ) : null}

        {preview ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm">{preview.effect}</p>

            {preview.skipped.length > 0 ? (
              <div
                role="status"
                className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-sm"
              >
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
                <div className="flex flex-col items-start gap-1.5">
                  <p>
                    {request?.change.kind === "delete_rows" ? (
                      <>
                        {preview.skipped.length}{" "}
                        {preview.skipped.length === 1 ? "row is" : "rows are"} gone and{" "}
                        {preview.skipped.length === 1 ? "is" : "are"} left out. A delete is found by
                        its key and does not compare values, so a row that was changed since you
                        loaded it is still deleted. Apply deletes the other rows only, or cancel and
                        reload to see the rows as they are.
                      </>
                    ) : (
                      <>
                        {preview.skipped.length} {preview.skipped.length === 1 ? "row" : "rows"}{" "}
                        changed since you loaded {preview.skipped.length === 1 ? "it" : "them"} (or{" "}
                        {preview.skipped.length === 1 ? "is" : "are"} gone) and{" "}
                        {preview.skipped.length === 1 ? "is" : "are"} left out. Apply changes the
                        other rows only, or cancel and reload to see the new values.
                      </>
                    )}
                  </p>
                  {onRowChanged ? (
                    <Button type="button" size="sm" variant="outline" onClick={onRowChanged}>
                      Reload the rows
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {request?.beforeAfter && request.beforeAfter.length > 0 ? (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Values before and after the change</caption>
                  <thead className="bg-muted text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Column
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Before
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        After
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {request.beforeAfter.map((row) => (
                      <tr key={row.column} className="border-t align-top">
                        <th scope="row" className="px-3 py-1.5 font-mono text-xs font-medium">
                          {row.column}
                        </th>
                        {[row.before, row.after].map((value, i) => (
                          <td
                            key={i}
                            className={cn(
                              "max-w-60 px-3 py-1.5 font-mono text-xs break-words whitespace-pre-wrap",
                              value.kind !== "value" && "text-muted-foreground italic",
                              value.kind === "value" && blurred && BLUR_CLASSES,
                            )}
                          >
                            {shownText(value)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Statement
                </h3>
                <CopyButton text={preview.statement} label="Copy the statement" />
              </div>
              <pre
                tabIndex={0}
                aria-label="The statement that will run"
                className="max-h-60 overflow-auto rounded-md bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap"
              >
                {preview.statement}
              </pre>
              {request?.change.kind === "update_row" ||
              request?.change.kind === "insert_row" ||
              request?.change.kind === "delete_row" ||
              request?.change.kind === "update_rows" ||
              request?.change.kind === "delete_rows" ||
              request?.change.kind === "insert_rows" ? (
                <p className="text-xs text-muted-foreground">
                  Values are sent separately as $1, $2 and so on, never as part of the statement.
                </p>
              ) : null}
            </div>

            {preview.warnings.length > 0 ? (
              <ul aria-label="Warnings" className="flex flex-col gap-2">
                {preview.warnings.map((warning) => (
                  <li
                    key={`${warning.code}-${warning.message}`}
                    className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-sm"
                  >
                    <AlertTriangle
                      className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                      aria-hidden="true"
                    />
                    {warning.message}
                  </li>
                ))}
              </ul>
            ) : null}

            {preview.destructive && step.kind !== "failed" ? (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-destructive"
                  checked={read}
                  onChange={(event) => setRead(event.target.checked)}
                  disabled={step.kind !== "ready"}
                />
                I have read this. It cannot be undone.
              </label>
            ) : null}
          </div>
        ) : null}

        {step.kind === "failed" ? (
          <div role="alert" className="flex flex-col items-start gap-2 rounded-lg border p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 text-destructive" aria-hidden="true" />
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">The change was not applied</p>
                <p className="text-sm text-muted-foreground">{step.error.message}</p>
              </div>
            </div>
            {step.error.code === "row_changed" && onRowChanged ? (
              <Button type="button" size="sm" onClick={onRowChanged}>
                Reload the rows
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setAttempt((n) => n + 1)}
              >
                Preview again
              </Button>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            {step.kind === "failed" || step.kind === "refused"
              ? "Close"
              : step.kind === "applying" && request?.change.kind === "insert_rows"
                ? "Cancel and roll back"
                : "Cancel"}
          </Button>
          {step.kind !== "failed" && step.kind !== "refused" ? (
            <Button
              type="button"
              variant={preview?.destructive ? "destructive" : "default"}
              disabled={!canApply}
              onClick={() => preview && void apply(preview)}
            >
              {step.kind === "applying" ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : null}
              Apply
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
