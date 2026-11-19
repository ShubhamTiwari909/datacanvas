/**
 * Saving a query tab as a `.sql` file and opening one (decision 141: the text is kept only in
 * memory, so a file is how a person keeps a query). Pure, so every rule is tested without a
 * browser; the view does the download and reads the file.
 */
import { SQL_MAX_TEXT_CHARS } from "@datacanvas/shared-types";

/** The largest file that is read at all, so a huge or binary file is not loaded into memory. */
export const MAX_SQL_FILE_BYTES = 1024 * 1024;

/** A file name from a tab name: nothing a file system or a download dialog dislikes. */
export function sqlFileName(tabName: string): string {
  const safe = tabName
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  // Windows will not save a file under the name of a device (CON, NUL, COM1, ...), with or without an extension.
  const named = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(safe) ? `_${safe}` : safe;
  return `${named || "query"}.sql`;
}

/** The same name with another extension (`Query 1.csv`). */
export const exportFileName = (tabName: string, extension: "csv" | "json" | "txt"): string =>
  sqlFileName(tabName).replace(/\.sql$/, `.${extension}`);

/** A tab name from a file name: without its extension. */
export function tabNameFromFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const name = base.replace(/\.(sql|txt|pgsql)$/i, "").trim();
  return name || "Opened file";
}

/** The text of a file as the editor holds it: line feeds only, no byte order mark. */
export const normalizeText = (text: string): string =>
  text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

export type FileCheck = { ok: true } | { ok: false; message: string };

export function checkFileSize(size: number): FileCheck {
  return size > MAX_SQL_FILE_BYTES
    ? { ok: false, message: "That file is larger than 1 MB, so it was not opened." }
    : { ok: true };
}

export function checkFileText(text: string): FileCheck {
  if (text.includes("\u0000")) {
    return { ok: false, message: "That file is not text, so it was not opened." };
  }
  if (text.length > SQL_MAX_TEXT_CHARS) {
    return {
      ok: false,
      message: `A statement can have at most ${new Intl.NumberFormat("en").format(SQL_MAX_TEXT_CHARS)} characters, and that file has more.`,
    };
  }
  return { ok: true };
}
