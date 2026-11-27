/**
 * "Import CSV" in the Data section (`docs/advanced-data-workspace-plan.md`, section 9; decision 160), only while
 * writes are unlocked and the table can be edited. Four steps in one window, none of which writes a row until the
 * person applies the preview:
 *
 *  1. choose a file: it is read and parsed HERE, as UTF-8, and refused (never repaired) when it is not valid; a
 *     file refused as UTF-8 can be read again, from the bytes already held, as UTF-16 or Windows-1252
 *     (`docs/write-side-v2-plan.md`, section 4.4). A file whose header ends in the rejects file's column is OFFERED
 *     its values back (section 4.3, item 3), never restored silently;
 *  2. say which column of the table each file column goes to, and how an empty field and some words are read;
 *  3. "Validate": the database checks the whole file in a temporary copy of the table, without writing a row, and
 *     says which rows break which rule (the numbers are the file's rows, the header counted). After failing rows,
 *     "Leave out the failing rows" validates again listing every one, leaves them out in the browser (they are
 *     never sent anywhere) and offers them as a rejects file; the import is then of the rows that remain;
 *  4. "Preview" hands the import to the preview step: one transaction, every row added or none, with a cancel.
 *
 * What happens to rows already in the table is a choice (`docs/write-side-v2-plan.md`, 4.1 and 4.2): add new rows
 * only (`insert_rows`), update the rows a key finds and add the others (`upsert_rows`), or update only the rows a
 * key finds (`update_by_key`). The key modes need a key the table offers (`TableEditInfo.uniqueKeys`), every column
 * of it mapped; an update only is not validated (its preview checks the rows against the table instead).
 *
 * The file and what was parsed from it live in this window's state and are gone when it closes.
 */
"use client";

import { useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AlertTriangle, Download, FileUp } from "lucide-react";
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
  type TableEditInfo,
  type TableRef,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SELECT_CLASS } from "@/components/ui/select";
import { validateRows } from "@/features/data/api";
import { useBlurStore, BLUR_CLASSES } from "@/features/data/blur-store";
import type { ChangeRequest } from "@/features/writes/change-dialog";
import { useValidation, ValidationPanel } from "@/features/writes/validation-panel";
import { cn } from "@/lib/utils";
import {
  DELIMITERS,
  decodeUtf8,
  detectDelimiter,
  parseCsv,
  refusalText,
  type Delimiter,
} from "./csv-parse";
import { ENCODINGS, decodeAs, type Encoding } from "./encodings";
import {
  COMMON_NULL_WORDS,
  buildChange,
  dataRowsOf,
  mappableColumns,
  mappingProblem,
  previewRows,
  rowsWords,
  suggestMapping,
  validateRequestForImport,
  type ImportMode,
  type NullRule,
} from "./import-plan";
import { MODE_DEFAULT, keyLabel, modeReducer, resolveMode } from "./import-mode";
import { dataRowsWithLines, planLeaveOut, type Reject, type ValidateRows } from "./leave-out";
import {
  LEAVE_OUT_IDLE,
  currentLeaveOut,
  failedText,
  leaveOutOffered,
  leaveOutReducer,
  progressText,
  readyText,
  refusedText,
  rejectsFileName,
} from "./leave-out-state";
import { buildRejectsCsv, isRejectsHeader, restoreRejectsRows } from "./rejects-file";

const DELIMITER_LABEL: Record<Delimiter, string> = {
  ",": "Comma ( , )",
  ";": "Semicolon ( ; )",
  "\t": "Tab",
  "|": "Pipe ( | )",
};

const MODE_LABEL: Record<ImportMode, string> = {
  insert: "Add new rows only",
  upsert: "Update existing rows, add the others",
  update: "Update existing rows only",
};
const MODES: readonly ImportMode[] = ["insert", "upsert", "update"];

const ENCODING_LABEL: Record<Encoding, string> = {
  "utf-8": "UTF-8",
  "utf-16": "UTF-16",
  "windows-1252": "Windows-1252 / Latin-1",
};

interface Loaded {
  /** The text of the file, and the name shown for it (the name only: never a path). */
  text: string;
  name: string;
  size: number;
  /** Tells one file from another (or the same file read in another encoding), for what depends on it. */
  id: number;
  /** Read as Windows-1252, the text holds what usually means a wrong encoding (`decodeAs`). */
  suspect: boolean;
}

/** A file refused as UTF-8, kept to be read again in the encoding the person chooses (never chosen for them). */
interface Held {
  bytes: ArrayBuffer;
  name: string;
  size: number;
}

/** A validation of the rows to leave out could not be asked: its fixed message, never a value. */
class CheckFailed extends Error {}

export function ImportDialog({
  open,
  onClose,
  connectionId,
  table,
  info,
  onPreview,
}: {
  open: boolean;
  onClose: () => void;
  connectionId: string;
  table: TableRef;
  info: TableEditInfo;
  onPreview: (request: ChangeRequest) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent size="builder">
        {open ? (
          <Body
            connectionId={connectionId}
            table={table}
            info={info}
            onClose={onClose}
            onPreview={onPreview}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  connectionId,
  table,
  info,
  onClose,
  onPreview,
}: {
  connectionId: string;
  table: TableRef;
  info: TableEditInfo;
  onClose: () => void;
  onPreview: (request: ChangeRequest) => void;
}) {
  const blurred = useBlurStore((s) => s.blurred);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [choice, setChoice] = useState<"auto" | Delimiter>("auto");
  const [header, setHeader] = useState(true);
  const [emptyIsNull, setEmptyIsNull] = useState(true);
  const [words, setWords] = useState<readonly string[]>([]);
  const [custom, setCustom] = useState("");
  // The field answers each key at once; the import is rebuilt (up to 100,000 rows) when typing pauses.
  const deferredCustom = useDeferredValue(custom);
  const [picked, setPicked] = useState<{ key: string; values: Array<string | null> } | null>(null);
  const counter = useRef(0);
  // A file refused as UTF-8 and the encoding it is read in: only while such a file is the one chosen.
  const [held, setHeld] = useState<Held | null>(null);
  const [encoding, setEncoding] = useState<Encoding>("utf-8");
  // The answer to "This looks like a DataCanvas rejects file", for the file (and encoding) it was given for.
  const [restore, setRestore] = useState<{ id: number; yes: boolean } | null>(null);
  const [leaving, dispatch] = useReducer(leaveOutReducer, LEAVE_OUT_IDLE);
  // What happens to rows already in the table: the mode, the key and the columns to update.
  const [modeState, dispatchMode] = useReducer(modeReducer, MODE_DEFAULT);
  const runs = useRef(0);
  const leaveOutAbort = useRef<AbortController | null>(null);
  const leaveOutButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const downloadButton = useRef<HTMLButtonElement>(null);
  const firstMapping = useRef<HTMLSelectElement>(null);

  // Found once for the file (it reads up to the whole text when there are few line breaks: about 0.3 s for 20 MB on one
  // line), not on every render.
  const detected = useMemo<Delimiter>(
    () => (loaded ? detectDelimiter(loaded.text) : ","),
    [loaded],
  );
  const delimiter: Delimiter = loaded ? (choice === "auto" ? detected : choice) : ",";
  const parsed = useMemo(
    () => (loaded ? parseCsv(loaded.text, delimiter) : null),
    [loaded, delimiter],
  );
  const parsedRows = parsed?.ok ? parsed.rows : null;
  const looksLikeRejects = parsedRows !== null && isRejectsHeader(parsedRows[0]);
  const restoreAnswer = loaded && restore?.id === loaded.id ? restore.yes : null;
  const restored = looksLikeRejects && restoreAnswer === true;
  // The rows of the file, with a rejects file's column dropped and its values restored once the person said yes.
  const rows = useMemo(
    () => (parsedRows && restored ? restoreRejectsRows(parsedRows) : parsedRows),
    [parsedRows, restored],
  );
  // The data rows of the whole file, each with the file's line it starts on.
  const fileData = useMemo(
    () => (rows && parsed?.ok ? dataRowsWithLines({ rows, lines: parsed.lines }, header) : null),
    [rows, parsed, header],
  );

  // What each file column is called: its header, or "Column 1", "Column 2" when the first row is data.
  const names = useMemo(
    () => (rows ? rows[0]!.map((h, i) => (header ? h : `Column ${i + 1}`)) : []),
    [rows, header],
  );
  // The mode and key alone (they do not depend on the mapping): an update only may map its key's columns even when
  // the database fills them, so they decide what a file column can go to.
  const keyMode = resolveMode(modeState, info, []);
  const modeName = keyMode.choice.mode;
  const keyColumns = keyMode.choice.key;
  const mappable = useMemo(
    () => mappableColumns(info, { mode: modeName, key: keyColumns }),
    [info, modeName, keyColumns],
  );
  // The choices belong to the file, its separator and its header: another of them starts again from a suggestion.
  const mappingKey = loaded ? `${loaded.id}|${delimiter}|${header}|${restored}` : "";
  const suggested = useMemo(
    () =>
      rows
        ? suggestMapping(header ? rows[0]! : names.map(() => ""), info, {
            mode: modeName,
            key: keyColumns,
          })
        : [],
    [rows, header, names, info, modeName, keyColumns],
  );
  const mapping = picked && picked.key === mappingKey ? picked.values : suggested;
  // Kept as one object while nothing it is made of changes: the import (up to 100,000 rows) is rebuilt from it.
  const resolved = useMemo(() => resolveMode(modeState, info, mapping), [modeState, info, mapping]);
  const importChoice = resolved.choice;
  const rule: NullRule = useMemo(
    () => ({ emptyIsNull, words: deferredCustom === "" ? words : [...words, deferredCustom] }),
    [emptyIsNull, words, deferredCustom],
  );

  // Rows left out belong to the file, its reading, the mapping, the mode and the key they were found with: any change
  // drops them (and the validation's answer, which is keyed the same way). A change of mode or key drops them for
  // good (`revision`): choosing the same mode and key again starts over.
  const basisKey = loaded
    ? `${mappingKey}|${JSON.stringify(mapping)}|${JSON.stringify(rule)}|${importChoice.mode}|${JSON.stringify(importChoice.key)}|${modeState.revision}`
    : "";
  const leftOut = currentLeaveOut(leaving, basisKey);
  const kept = leftOut.status === "ready" ? leftOut.data : null;
  // The rows to import: the whole file, or what remains once the failing rows are left out.
  const importRows = useMemo(() => {
    const now = currentLeaveOut(leaving, basisKey);
    if (!rows || now.status !== "ready") return rows;
    return header ? [rows[0]!, ...now.data.rows] : now.data.rows;
  }, [rows, leaving, basisKey, header]);
  const dataRows = importRows ? dataRowsOf({ rows: importRows, header }).length : 0;
  // The file's line of a row the check names (it counts the rows it was sent, from 1): blank lines, line breaks in
  // quotes and the rows left out are in the file but not among the rows sent.
  const sentLines = kept ? kept.lines : (fileData?.lines ?? []);
  const fileLine = (row: number) => sentLines[row - 1] ?? row;

  // What is chosen, checked and turned into the change once (it can hold 100,000 rows), not on every render.
  const built = useMemo(() => {
    if (!importRows) return { blocked: "Choose a file.", change: null, preview: null };
    // The NULL word is still being typed: acting now would use the previous word.
    if (custom !== deferredCustom)
      return { blocked: "Updating the NULL word…", change: null, preview: null };
    const blocked = mappingProblem(info, mapping, dataRows, importChoice);
    if (blocked !== null) return { blocked, change: null, preview: null };
    const input = { rows: importRows, header, mapping, rule };
    return {
      blocked: null,
      change: buildChange(table, input, importChoice),
      preview: previewRows(input, 8),
    };
  }, [
    importRows,
    header,
    mapping,
    rule,
    info,
    table,
    dataRows,
    custom,
    deferredCustom,
    importChoice,
  ]);
  const { blocked, change, preview } = built;
  // An update only is not validated: its preview checks each row against the table.
  const validates = importChoice.mode !== "update";
  const validation = useValidation(
    connectionId,
    change ? validateRequestForImport(change) : null,
    // Leaving rows out changes the rows sent: the answer about the whole file no longer applies.
    change
      ? `${basisKey}|${leftOut.status === "ready" ? `left-out:${leftOut.run}` : "whole"}`
      : undefined,
  );
  const report = validation.outcome?.status === "done" ? validation.outcome.report : null;
  const running = leftOut.status === "running";

  // A change of the file, its reading or the mapping while rows are being checked again stops the check (and so
  // does closing the window): its answer would be about other choices.
  useEffect(() => {
    return () => leaveOutAbort.current?.abort();
  }, [basisKey]);

  // Focus follows the leave-out: to its Cancel while it runs, to the rejects file when rows were left out, and back
  // to the button that started it otherwise.
  const status = leftOut.status;
  const previousStatus = useRef(status);
  useEffect(() => {
    const was = previousStatus.current;
    previousStatus.current = status;
    if (was === status) return;
    if (status === "running") cancelButton.current?.focus();
    else if (status === "ready") downloadButton.current?.focus();
    else if (was === "running") leaveOutButton.current?.focus();
  }, [status]);

  // Once the rejects-file offer is answered it goes away: focus moves on to choosing the columns.
  useEffect(() => {
    if (restoreAnswer !== null) firstMapping.current?.focus();
  }, [restoreAnswer]);

  async function choose(file: File | undefined): Promise<boolean> {
    // A later choice (or a cleared one) makes an earlier file's slow read stale: only the latest is used.
    counter.current += 1;
    const mine = counter.current;
    setLoaded(null);
    setProblem(null);
    setPicked(null);
    setHeld(null);
    setEncoding("utf-8");
    if (!file) return false;
    if (file.size > IMPORT_MAX_FILE_BYTES) {
      setProblem(`The file is larger than ${IMPORT_MAX_FILE_BYTES / (1024 * 1024)} MB.`);
      return false;
    }
    const bytes = await file.arrayBuffer();
    if (counter.current !== mine) return true;
    const decoded = decodeUtf8(bytes);
    if (!decoded.ok) {
      // Kept, and the input with it: the person may read the same bytes in another encoding.
      setHeld({ bytes, name: file.name, size: file.size });
      setProblem(refusalText("not_utf8"));
      return true;
    }
    setLoaded({ text: decoded.text, name: file.name, size: file.size, id: mine, suspect: false });
    return true;
  }

  /** The file refused as UTF-8, read again from the bytes held, in the encoding chosen. */
  function readAs(next: Encoding) {
    if (!held) return;
    counter.current += 1;
    const mine = counter.current;
    setEncoding(next);
    setPicked(null);
    const decoded = decodeAs(held.bytes, next);
    if (!decoded.ok) {
      setLoaded(null);
      setProblem(refusalText(decoded.refusal));
      return;
    }
    setProblem(null);
    setLoaded({
      text: decoded.text,
      name: held.name,
      size: held.size,
      id: mine,
      suspect: decoded.suspect,
    });
  }

  /**
   * Validate again listing every failing row, leave them out, and again (up to 5 rounds), from the whole file. The
   * requests are the usual validation's (same table, mapping and rule) with `listAll`; the rows left out stay here.
   */
  function startLeaveOut() {
    if (!rows || !fileData || !loaded) return;
    leaveOutAbort.current?.abort();
    const abort = new AbortController();
    leaveOutAbort.current = abort;
    const run = ++runs.current;
    dispatch({ type: "start", key: basisKey, run });
    const headerRow = header ? [rows[0]!] : [];
    const input = { header, mapping, rule };
    // The mode and key of the start: a change of either aborts the run (it changes `basisKey`).
    const started = importChoice;
    let round = 0;
    const validate: ValidateRows = async (subset, signal) => {
      round += 1;
      dispatch({ type: "round", run, round });
      const request = validateRequestForImport(
        buildChange(table, { ...input, rows: [...headerRow, ...subset] }, started),
      );
      if (request === null) throw new CheckFailed("An update only is not validated.");
      const result = await validateRows(connectionId, { ...request, listAll: true }, signal);
      if (result.ok) return result.data;
      throw new CheckFailed(result.error.message);
    };
    void planLeaveOut(fileData, validate, abort.signal)
      .then(
        (outcome) => dispatch({ type: "outcome", run, outcome }),
        (error: unknown) => {
          if (abort.signal.aborted) dispatch({ type: "cancelled", run });
          else
            dispatch({
              type: "failed",
              run,
              message:
                error instanceof CheckFailed ? error.message : "Validate the file and try again.",
            });
        },
      )
      .finally(() => {
        if (leaveOutAbort.current === abort) leaveOutAbort.current = null;
      });
  }

  /** The rows left out, as a CSV the person can fix and import again: made here, saved here, sent nowhere. */
  function downloadRejects(rejects: readonly Reject[]) {
    if (!rows || !loaded) return;
    const text = buildRejectsCsv({
      header: header ? rows[0]! : null,
      rejects,
      delimiter,
      types: new Map(info.columns.map((c) => [c.name, c.dataType])),
    });
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = rejectsFileName(loaded.name);
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  // Shown with the refusals too: "choose the separator it uses" needs the control to choose it with.
  const separatorControl = loaded ? (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="import-separator">Separator</Label>
      <select
        id="import-separator"
        className={SELECT_CLASS}
        value={choice}
        onChange={(event) => setChoice(event.target.value as "auto" | Delimiter)}
      >
        <option value="auto">Found: {DELIMITER_LABEL[detected]}</option>
        {DELIMITERS.map((d) => (
          <option key={d} value={d}>
            {DELIMITER_LABEL[d]}
          </option>
        ))}
      </select>
    </div>
  ) : null;

  const refusal = parsed && !parsed.ok ? refusalText(parsed.refusal, parsed.row) : null;

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>
          Import a CSV file into <span className="font-mono">{table.name}</span>
        </DialogTitle>
        <DialogDescription>
          The file is read on this computer and nothing is written until you apply the preview. It
          is all or nothing: if any row is refused, no row is added. Up to{" "}
          {IMPORT_MAX_ROWS.toLocaleString("en-US")} rows and {IMPORT_MAX_FILE_BYTES / (1024 * 1024)}{" "}
          MB, UTF-8 (UTF-16 or Windows-1252 can be chosen if the file is refused).
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="import-file">CSV file</Label>
        <input
          id="import-file"
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/plain"
          className="text-sm file:mr-3 file:rounded-md file:border file:bg-muted file:px-3 file:py-1 file:text-sm"
          onChange={(event) => {
            const input = event.currentTarget;
            // A refused file leaves the input empty, so choosing the corrected file (even under the same name) fires
            // a change again.
            void choose(input.files?.[0]).then((accepted) => {
              if (!accepted) input.value = "";
            });
          }}
        />
        {problem ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}
        {refusal ? (
          <p role="alert" className="text-sm text-destructive">
            {refusal}
          </p>
        ) : null}
      </div>
      {held ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="import-encoding">Read this file as</Label>
          <select
            id="import-encoding"
            className={cn(SELECT_CLASS, "max-w-xs")}
            value={encoding}
            onChange={(event) => readAs(event.target.value as Encoding)}
          >
            {ENCODINGS.map((e) => (
              <option key={e} value={e}>
                {ENCODING_LABEL[e]}
              </option>
            ))}
          </select>
          {loaded?.suspect ? (
            <p
              role="status"
              className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-sm"
            >
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              The text holds characters that usually mean a wrong encoding: check the first rows
              below.
            </p>
          ) : null}
        </div>
      ) : null}
      {refusal ? separatorControl : null}

      {rows && looksLikeRejects && restoreAnswer === null ? (
        <div
          role="group"
          aria-labelledby="import-rejects-offer"
          className="flex flex-col gap-2 rounded-lg border p-3"
        >
          <p id="import-rejects-offer" className="text-sm">
            This looks like a DataCanvas rejects file: ignore that column and restore the values?
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => loaded && setRestore({ id: loaded.id, yes: true })}
            >
              Yes
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => loaded && setRestore({ id: loaded.id, yes: false })}
            >
              No
            </Button>
          </div>
        </div>
      ) : null}

      {rows ? (
        <>
          <div className="flex flex-wrap items-end gap-4">
            {separatorControl}
            <label className="flex items-center gap-2 pb-1.5 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={header}
                onChange={(event) => setHeader(event.target.checked)}
              />
              The first row holds the column names
            </label>
            <p role="status" className="pb-1.5 text-sm text-muted-foreground">
              {rowsWords(dataRows)}, {rows[0]!.length}{" "}
              {rows[0]!.length === 1 ? "column" : "columns"}
            </p>
          </div>

          <fieldset className="flex flex-col gap-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">Where each column goes</legend>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">
                  The column of the table for each column of the file
                </caption>
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-2 py-1 font-medium">
                      Column of the file
                    </th>
                    <th scope="col" className="px-2 py-1 font-medium">
                      First value
                    </th>
                    <th scope="col" className="px-2 py-1 font-medium">
                      Goes to
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {names.map((name, i) => (
                    <tr key={i} className="border-t align-top">
                      <th
                        scope="row"
                        className="px-2 py-1.5 font-mono text-xs font-medium break-all"
                      >
                        {name}
                      </th>
                      <td
                        className={cn(
                          "max-w-48 truncate px-2 py-1.5 font-mono text-xs",
                          blurred && BLUR_CLASSES,
                        )}
                      >
                        {rows[header ? 1 : 0]?.[i] ?? ""}
                      </td>
                      <td className="px-2 py-1">
                        <select
                          ref={i === 0 ? firstMapping : undefined}
                          aria-label={`Column of the table for file column ${i + 1}, ${name}`}
                          className={SELECT_CLASS}
                          value={mapping[i] ?? ""}
                          onChange={(event) => {
                            const next = [...mapping];
                            next[i] = event.target.value === "" ? null : event.target.value;
                            setPicked({ key: mappingKey, values: next });
                          }}
                        >
                          <option value="">Ignore this column</option>
                          {mappable.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name} ({c.dataType})
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Names in the file are never used as names in the database: you choose the column of
              the table for each one.
            </p>
          </fieldset>

          <fieldset className="flex flex-col gap-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">
              How an empty field and some words are read
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={emptyIsNull}
                onChange={(event) => setEmptyIsNull(event.target.checked)}
              />
              An empty field is NULL (otherwise it is the empty string)
            </label>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {COMMON_NULL_WORDS.map((word) => (
                <label key={word} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={words.includes(word)}
                    onChange={(event) =>
                      setWords((current) =>
                        event.target.checked
                          ? [...current, word]
                          : current.filter((w) => w !== word),
                      )
                    }
                  />
                  <span className="font-mono text-xs">{word}</span> is NULL
                </label>
              ))}
            </div>
            <div className="flex max-w-xs flex-col gap-1.5">
              <Label htmlFor="import-null-word">Another word that means NULL</Label>
              <Input
                id="import-null-word"
                autoComplete="off"
                maxLength={50}
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
              />
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">
              What should happen to rows already in the table?
            </legend>
            <div className="flex flex-col gap-1.5 text-sm">
              {MODES.map((mode) => {
                const unavailable = mode !== "insert" && !resolved.offered;
                return (
                  <label
                    key={mode}
                    className={cn(
                      "flex items-center gap-2",
                      unavailable && "cursor-not-allowed text-muted-foreground",
                    )}
                  >
                    <input
                      type="radio"
                      name="import-mode"
                      className="size-4"
                      value={mode}
                      checked={importChoice.mode === mode}
                      disabled={unavailable}
                      aria-describedby={unavailable ? "import-mode-unavailable" : undefined}
                      onChange={() => dispatchMode({ type: "mode", mode })}
                    />
                    {MODE_LABEL[mode]}
                  </label>
                );
              })}
            </div>
            {!resolved.offered ? (
              <p id="import-mode-unavailable" className="text-xs text-muted-foreground">
                {resolved.hiddenKeys > 0
                  ? "Updating needs a primary key or unique constraint that an import can use, and every one this table has includes a column whose name looks sensitive (its values are hidden), which cannot be used to find rows."
                  : "Updating needs a primary key or unique constraint that an import can use (not partial, not deferrable, every column NOT NULL), and this table has none."}
              </p>
            ) : resolved.hiddenKeys > 0 ? (
              <p className="text-xs text-muted-foreground">
                {resolved.hiddenKeys === 1
                  ? "1 key of this table is not offered: it includes a column whose name looks sensitive (its values are hidden), which cannot be used to find rows."
                  : `${resolved.hiddenKeys} keys of this table are not offered: they include a column whose name looks sensitive (its values are hidden), which cannot be used to find rows.`}
              </p>
            ) : null}

            {resolved.key ? (
              <div className="flex max-w-md flex-col gap-1.5">
                <Label htmlFor="import-key">Key that finds each row</Label>
                <select
                  id="import-key"
                  className={SELECT_CLASS}
                  value={resolved.key.name}
                  onChange={(event) => dispatchMode({ type: "key", name: event.target.value })}
                >
                  {resolved.keys.map((k) => (
                    <option key={k.name} value={k.name}>
                      {keyLabel(k)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {importChoice.mode === "upsert" ? (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-sm font-medium">Columns to update</legend>
                {resolved.updatable.length > 0 ? (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    {resolved.updatable.map((column) => (
                      <label key={column} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={importChoice.updateColumns.includes(column)}
                          disabled={modeState.leaveExisting}
                          onChange={(event) =>
                            dispatchMode({
                              type: "column",
                              column,
                              checked: event.target.checked,
                            })
                          }
                        />
                        <span className="font-mono text-xs">{column}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No mapped column can be updated (each is part of a key), so rows that already
                    exist are left as they are.
                  </p>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={modeState.leaveExisting}
                    onChange={(event) =>
                      dispatchMode({ type: "leave_existing", checked: event.target.checked })
                    }
                  />
                  Leave existing rows as they are
                </label>
                <p className="text-xs text-muted-foreground">
                  Columns of the table&apos;s keys are not offered: an update cannot change them.
                </p>
              </fieldset>
            ) : null}

            {importChoice.mode === "update" ? (
              <p className="text-xs text-muted-foreground">
                Every mapped column that is not the key is set on the row the key finds. There is no
                validation for an update only: the preview checks each row of the file against the
                table and leaves out the rows that find none.
              </p>
            ) : null}
          </fieldset>

          {blocked ? (
            <p role="note" className="text-sm text-muted-foreground">
              {blocked}
            </p>
          ) : null}

          {preview ? (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-sm font-medium">The first rows, as they will be read</h3>
              <div className={cn("overflow-x-auto rounded-lg border", blurred && BLUR_CLASSES)}>
                <table className="w-full text-left text-xs">
                  <caption className="sr-only">The first rows of the import</caption>
                  <thead className="bg-muted text-foreground">
                    <tr>
                      {preview.columns.map((c) => (
                        <th key={c} scope="col" className="px-2 py-1.5 font-mono font-medium">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, r) => (
                      <tr key={r} className="border-t">
                        {row.map((value, c) => (
                          <td
                            key={c}
                            className={cn(
                              "max-w-48 truncate px-2 py-1 font-mono",
                              value === null && "text-muted-foreground italic",
                            )}
                          >
                            {value === null ? "NULL" : value === "" ? "(empty)" : value}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <ValidationPanel validation={validation} rowLabel={fileLine} />
          {validation.outcome?.status === "done" ? (
            <p className="text-xs text-muted-foreground">
              Row numbers are the file&apos;s lines, as a text editor counts them
              {header ? " (the names are the first row)" : ""}.
            </p>
          ) : null}

          {report && leaveOutOffered(report, false) && !running ? (
            <div>
              <Button
                ref={leaveOutButton}
                type="button"
                size="sm"
                variant="outline"
                onClick={startLeaveOut}
              >
                Leave out the failing rows
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {/* Always in the page, so a screen reader announces each round and the outcome. */}
            <p
              role="status"
              aria-label="Leaving out the failing rows"
              aria-live="polite"
              className={
                leftOut.status === "refused" || leftOut.status === "failed"
                  ? "text-destructive"
                  : leftOut.status === "ready"
                    ? "text-foreground"
                    : "text-muted-foreground"
              }
            >
              {leftOut.status === "running" ? progressText(leftOut.round) : null}
              {leftOut.status === "ready"
                ? readyText(leftOut.rejects.length, leftOut.data.rows.length)
                : null}
              {leftOut.status === "refused" ? refusedText(leftOut.refusal) : null}
              {leftOut.status === "failed" ? failedText(leftOut.message) : null}
            </p>
            {leftOut.status === "running" ? (
              <Button
                ref={cancelButton}
                type="button"
                size="sm"
                variant="outline"
                aria-label="Cancel the check of the failing rows"
                onClick={() => leaveOutAbort.current?.abort()}
              >
                Cancel
              </Button>
            ) : null}
            {leftOut.status === "ready" ? (
              <Button
                ref={downloadButton}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => downloadRejects(leftOut.rejects)}
              >
                <Download aria-hidden="true" />
                Download rejects file
              </Button>
            ) : null}
          </div>
        </>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        {validates ? (
          <Button
            type="button"
            variant="outline"
            disabled={change === null || validation.busy || running}
            onClick={validation.run}
          >
            Validate the file
          </Button>
        ) : null}
        <Button
          type="button"
          disabled={change === null || running}
          onClick={() => {
            if (!change) return;
            const rowsSent = rowsWords(change.rows.length);
            const name = `${table.schema}.${table.name}`;
            onPreview({
              change,
              title:
                change.kind === "upsert_rows"
                  ? `Update or add ${rowsSent} in ${name}`
                  : change.kind === "update_by_key"
                    ? `Update ${name} from ${rowsSent} of a file`
                    : `Import ${rowsSent} into ${name}`,
              rowLines: sentLines,
            });
          }}
        >
          <FileUp aria-hidden="true" />
          Preview the import
        </Button>
      </DialogFooter>
    </div>
  );
}
