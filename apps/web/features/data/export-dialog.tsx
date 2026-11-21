/**
 * "Export" in the Data section (`docs/advanced-data-workspace-plan.md`, section 8; decision 158): the rows of
 * the table as filtered and sorted on screen, written to a file on this machine as CSV, TSV, JSON or NDJSON.
 *
 * The file is built by the server a batch at a time and received here as a stream, so the dialog can show how
 * much has arrived and Cancel stops it (the read in the database stops too). Up to 100,000 rows and 64 MB; a
 * file that reaches a limit ends with a note that says so. Columns whose names look sensitive are left out
 * unless shown, and the notes name them. Nothing about the file is kept by DataCanvas: it is saved by the
 * browser, under a name of the table and the moment.
 */
"use client";

import { useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import {
  EXPORT_MAX_BYTES,
  EXPORT_MAX_ROWS,
  type ExportRowsFormat,
  type RowFilter,
  type RowSort,
} from "@datacanvas/database-core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, FormStack } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SELECT_CLASS } from "@/components/ui/select";
import { exportRowsFile } from "./api";
import { exportFileName, sizeText } from "./export-file";

const FORMATS: Array<{ value: ExportRowsFormat; label: string; hint: string }> = [
  {
    value: "csv",
    label: "CSV",
    hint: "For a spreadsheet. Starts with a byte order mark so it opens as UTF-8.",
  },
  { value: "tsv", label: "TSV", hint: "Like CSV with tabs." },
  {
    value: "json",
    label: "JSON",
    hint: 'An object: { "rows": [...], "_meta": {...} }. Values are text, as shown.',
  },
  { value: "ndjson", label: "NDJSON", hint: "One JSON object per line." },
];

type Run =
  | { status: "idle" }
  | { status: "running"; bytes: number }
  | { status: "done"; bytes: number; name: string }
  | { status: "error"; message: string };

const number = new Intl.NumberFormat();

export function ExportDialog({
  open,
  onClose,
  connectionId,
  schema,
  table,
  reveal,
  sort,
  filters,
}: {
  open: boolean;
  onClose: () => void;
  connectionId: string;
  schema: string;
  table: string;
  /** The columns the person chose to read although their names look sensitive. */
  reveal: readonly string[];
  sort: RowSort | null;
  filters: readonly RowFilter[];
}) {
  const [format, setFormat] = useState<ExportRowsFormat>("csv");
  const [delimiter, setDelimiter] = useState<"," | ";">(",");
  const [header, setHeader] = useState(true);
  const [nullText, setNullText] = useState("");
  const [meta, setMeta] = useState(false);
  const [run, setRun] = useState<Run>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);
  const running = run.status === "running";

  const start = async () => {
    const abort = new AbortController();
    controller.current = abort;
    setRun({ status: "running", bytes: 0 });
    const result = await exportRowsFile(
      connectionId,
      {
        schema,
        table,
        format,
        delimiter,
        header,
        nullText,
        meta,
        revealColumns: [...reveal],
        sort,
        filters: [...filters],
      },
      { signal: abort.signal, onProgress: (bytes) => setRun({ status: "running", bytes }) },
    );
    if (controller.current !== abort) return;
    controller.current = null;
    if (!result.ok) {
      setRun(
        result.error.code === "aborted"
          ? { status: "idle" }
          : { status: "error", message: result.error.message },
      );
      return;
    }
    // The browser saves it: a link to the file in memory, used once.
    const name = exportFileName(table, format, new Date());
    const url = URL.createObjectURL(result.data.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setRun({ status: "done", bytes: result.data.bytes, name });
  };

  const cancel = () => {
    controller.current?.abort();
    controller.current = null;
    setRun({ status: "idle" });
  };

  const close = () => {
    if (running) cancel();
    onClose();
  };

  const filterWords =
    filters.length === 0
      ? "all rows"
      : `the rows that match ${filters.length} ${filters.length === 1 ? "filter" : "filters"}`;
  const delimited = format === "csv" || format === "tsv";

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && close()}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>
            Export <span className="font-mono">{table}</span>
          </DialogTitle>
          <DialogDescription>
            Writes {filterWords}, in the order on screen
            {sort ? ` (sorted by ${sort.column})` : ""}, to a file on this computer. Up to{" "}
            {number.format(EXPORT_MAX_ROWS)} rows and {EXPORT_MAX_BYTES / (1024 * 1024)} MB: a
            longer table ends the file with a line that says it was cut.
          </DialogDescription>
        </DialogHeader>

        <FormStack className="gap-3">
          <FormField label="Format" hint={FORMATS.find((f) => f.value === format)?.hint}>
            {(field) => (
              <select
                {...field}
                className={SELECT_CLASS}
                value={format}
                disabled={running}
                onChange={(event) => setFormat(event.target.value as ExportRowsFormat)}
              >
                {FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          {format === "csv" ? (
            <FormField label="Separator">
              {(field) => (
                <select
                  {...field}
                  className={SELECT_CLASS}
                  value={delimiter}
                  disabled={running}
                  onChange={(event) => setDelimiter(event.target.value as "," | ";")}
                >
                  <option value=",">Comma ( , )</option>
                  <option value=";">Semicolon ( ; )</option>
                </select>
              )}
            </FormField>
          ) : null}
          {delimited ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={header}
                  disabled={running}
                  onChange={(event) => setHeader(event.target.checked)}
                />
                First line holds the column names
              </label>
              <FormField
                label="Write NULL as"
                hint="Empty by default. An empty string is always written empty, so this is the only way to tell them apart."
              >
                {(field) => (
                  <Input
                    {...field}
                    autoComplete="off"
                    maxLength={50}
                    disabled={running}
                    value={nullText}
                    onChange={(event) => setNullText(event.target.value)}
                    placeholder="(empty)"
                  />
                )}
              </FormField>
            </>
          ) : null}
          {format === "json" ? (
            <p className="text-xs text-muted-foreground">
              A JSON file always ends with its notes (the table, the time, how many rows, what was
              left out, whether it was cut).
            </p>
          ) : (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={meta}
                disabled={running}
                onChange={(event) => setMeta(event.target.checked)}
              />
              Add notes at the end: the table, the time, how many rows, what was left out
            </label>
          )}
        </FormStack>

        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          <li>
            Columns whose names look sensitive (a password, a token, a key) are left out unless you
            showed them in the grid. The notes name them.
          </li>
          <li>
            A value a spreadsheet would run as a formula gets a leading apostrophe, so opening the
            file runs nothing.
          </li>
          <li>
            The file is made on this computer from rows you can see here. DataCanvas keeps nothing
            of it.
          </li>
        </ul>

        <div role="status" aria-live="polite" className="text-sm">
          {run.status === "running" ? (
            <p className="text-muted-foreground">
              Receiving the file… {sizeText(run.bytes)} so far.
            </p>
          ) : null}
          {run.status === "done" ? (
            <p>
              Saved <span className="font-mono">{run.name}</span> ({sizeText(run.bytes)}). If the
              table was longer than the limit, the file ends with a line that says it was cut.
            </p>
          ) : null}
          {run.status === "error" ? (
            <p className="text-destructive">The export failed. {run.message}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            {running ? "Cancel and close" : "Close"}
          </Button>
          {running ? (
            <Button type="button" variant="outline" onClick={cancel}>
              Cancel the export
            </Button>
          ) : null}
          <Button type="button" disabled={running} onClick={() => void start()}>
            {running ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Download aria-hidden="true" />
            )}
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
