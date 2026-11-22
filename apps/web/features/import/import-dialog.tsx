/**
 * "Import CSV" in the Data section (`docs/advanced-data-workspace-plan.md`, section 9; decision 160), only while
 * writes are unlocked and the table can be edited. Four steps in one window, none of which writes a row until the
 * person applies the preview:
 *
 *  1. choose a file: it is read and parsed HERE, as UTF-8 only, and refused (never repaired) when it is not valid;
 *  2. say which column of the table each file column goes to, and how an empty field and some words are read;
 *  3. "Validate": the database checks the whole file in a temporary copy of the table, without writing a row, and
 *     says which rows break which rule (the numbers are the file's rows, the header counted);
 *  4. "Preview" hands the import to the preview step: one transaction, every row added or none, with a cancel.
 *
 * The file and what was parsed from it live in this window's state and are gone when it closes.
 */
"use client";

import { useMemo, useRef, useState } from "react";
import { FileUp } from "lucide-react";
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
import { useBlurStore, BLUR_CLASSES } from "@/features/data/blur-store";
import type { ChangeRequest } from "@/features/writes/change-dialog";
import { useValidation, ValidationPanel } from "@/features/writes/validation-panel";
import { validateRequestFor } from "@/features/writes/validation";
import { cn } from "@/lib/utils";
import {
  DELIMITERS,
  decodeUtf8,
  detectDelimiter,
  parseCsv,
  refusalText,
  type Delimiter,
} from "./csv-parse";
import {
  COMMON_NULL_WORDS,
  buildImport,
  dataRowsOf,
  importableColumns,
  mappingProblem,
  previewRows,
  rowsWords,
  suggestMapping,
  type NullRule,
} from "./import-plan";

const DELIMITER_LABEL: Record<Delimiter, string> = {
  ",": "Comma ( , )",
  ";": "Semicolon ( ; )",
  "\t": "Tab",
  "|": "Pipe ( | )",
};

interface Loaded {
  /** The text of the file, and the name shown for it (the name only: never a path). */
  text: string;
  name: string;
  size: number;
  /** Tells one file from another, for what depends on it. */
  id: number;
}

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
  const [picked, setPicked] = useState<{ key: string; values: Array<string | null> } | null>(null);
  const counter = useRef(0);

  const delimiter: Delimiter = loaded
    ? choice === "auto"
      ? detectDelimiter(loaded.text)
      : choice
    : ",";
  const parsed = useMemo(
    () => (loaded ? parseCsv(loaded.text, delimiter) : null),
    [loaded, delimiter],
  );
  const rows = parsed?.ok ? parsed.rows : null;

  // What each file column is called: its header, or "Column 1", "Column 2" when the first row is data.
  const names = useMemo(
    () => (rows ? rows[0]!.map((h, i) => (header ? h : `Column ${i + 1}`)) : []),
    [rows, header],
  );
  // The choices belong to the file, its separator and its header: another of them starts again from a suggestion.
  const mappingKey = loaded ? `${loaded.id}|${delimiter}|${header}` : "";
  const suggested = useMemo(
    () => (rows ? suggestMapping(header ? rows[0]! : names, info) : []),
    [rows, header, names, info],
  );
  const mapping = picked && picked.key === mappingKey ? picked.values : suggested;
  const rule: NullRule = useMemo(
    () => ({ emptyIsNull, words: custom === "" ? words : [...words, custom] }),
    [emptyIsNull, words, custom],
  );
  const dataRows = rows ? dataRowsOf({ rows, header }).length : 0;

  // What is chosen, checked and turned into the change once (it can hold 100,000 rows), not on every render.
  const built = useMemo(() => {
    if (!rows) return { blocked: "Choose a file.", change: null, preview: null };
    const blocked = mappingProblem(info, mapping, dataRows);
    if (blocked !== null) return { blocked, change: null, preview: null };
    const input = { rows, header, mapping, rule };
    return { blocked: null, change: buildImport(table, input), preview: previewRows(input, 8) };
  }, [rows, header, mapping, rule, info, table, dataRows]);
  const { blocked, change, preview } = built;
  const validation = useValidation(
    connectionId,
    change ? validateRequestFor(change) : null,
    change ? `${mappingKey}|${JSON.stringify(mapping)}|${JSON.stringify(rule)}` : undefined,
  );

  async function choose(file: File | undefined) {
    setLoaded(null);
    setProblem(null);
    setPicked(null);
    if (!file) return;
    if (file.size > IMPORT_MAX_FILE_BYTES) {
      setProblem(`The file is larger than ${IMPORT_MAX_FILE_BYTES / (1024 * 1024)} MB.`);
      return;
    }
    const decoded = decodeUtf8(await file.arrayBuffer());
    if (!decoded.ok) {
      setProblem(refusalText("not_utf8"));
      return;
    }
    counter.current += 1;
    setLoaded({ text: decoded.text, name: file.name, size: file.size, id: counter.current });
  }

  const importable = importableColumns(info);
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
          MB, UTF-8 only.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="import-file">CSV file</Label>
        <input
          id="import-file"
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/plain"
          className="text-sm file:mr-3 file:rounded-md file:border file:bg-muted file:px-3 file:py-1 file:text-sm"
          onChange={(event) => void choose(event.target.files?.[0])}
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

      {rows ? (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="import-separator">Separator</Label>
              <select
                id="import-separator"
                className={SELECT_CLASS}
                value={choice}
                onChange={(event) => setChoice(event.target.value as "auto" | Delimiter)}
              >
                <option value="auto">
                  Found: {DELIMITER_LABEL[detectDelimiter(loaded!.text)]}
                </option>
                {DELIMITERS.map((d) => (
                  <option key={d} value={d}>
                    {DELIMITER_LABEL[d]}
                  </option>
                ))}
              </select>
            </div>
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
                          {importable.map((c) => (
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

          <ValidationPanel validation={validation} rowOffset={header ? 1 : 0} />
          {validation.outcome?.status === "done" ? (
            <p className="text-xs text-muted-foreground">
              Row numbers are the file&apos;s rows
              {header ? ", the first row (the names) being row 1" : ""}.
            </p>
          ) : null}
        </>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={change === null || validation.busy}
          onClick={validation.run}
        >
          Validate the file
        </Button>
        <Button
          type="button"
          disabled={change === null}
          onClick={() => {
            if (!change) return;
            onPreview({
              change,
              title: `Import ${rowsWords(change.rows.length)} into ${table.schema}.${table.name}`,
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
