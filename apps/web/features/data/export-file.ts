/**
 * The pure parts of the export dialog (`docs/advanced-data-workspace-plan.md`, section 8): the name of the file
 * and what is said about it. The name has the table and the moment, and nothing else: no connection name, no
 * database, no value.
 */
import { EXPORT_MEDIA, type ExportRowsFormat } from "@datacanvas/database-core";

/** `orders-20261121-143005.csv`: the table's name reduced to letters, digits, `-` and `_`, then the moment. */
export function exportFileName(table: string, format: ExportRowsFormat, at: Date): string {
  const safe =
    table
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "table";
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${safe}-${day}-${time}.${EXPORT_MEDIA[format].extension}`;
}

/** A size for people: `1.4 MB`. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  // The unit is chosen after rounding: 1,048,000 bytes is "1.0 MB", not "1023.4 KB" turning into "1024.0 KB".
  if (Number((bytes / 1024).toFixed(1)) < 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
