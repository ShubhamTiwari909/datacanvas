/**
 * "Export documentation": the structure of the database (or one schema) as a Markdown data dictionary, a Mermaid, DBML
 * or PlantUML diagram, made in the browser and saved by the browser (`docs/insight-release-plan.md`, section 7; decision
 * 166). It reads the structure DataCanvas already reads (names, types, keys, indexes): no row, no value, no
 * "Allow viewing table data", nothing uploaded. It says what the file contains BEFORE it is made, like the image export.
 */
"use client";

import { useEffect, useState } from "react";
import { Download, Loader2, ShieldAlert } from "lucide-react";
import type { TableDetailsEntry, TableRef } from "@datacanvas/database-core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getRelationships, getSchemas, getTables, getTablesDetails } from "@/features/explorer/api";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { FORMAT_LABEL, generateDoc } from "./generate";
import { DOC_FORMATS, type DocFormat } from "./types";

/** The most tables one file describes: a database with more is documented a schema at a time. */
export const DOC_MAX_TABLES = 5000;
const CHUNK = 400;

function save(name: string, text: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DocsExportDialog({
  connectionId,
  open,
  onOpenChange,
}: {
  connectionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const title = useWorkspaceStore(
    (s) => s.connections.find((c) => c.id === connectionId)?.name ?? "database",
  );
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [scope, setScope] = useState<string>("*");
  const [format, setFormat] = useState<DocFormat>("markdown");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The list of schemas is read when the dialog opens (structure only).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getSchemas(connectionId).then((result) => {
      if (cancelled) return;
      if (result.ok) setSchemas(result.data.map((s) => s.name));
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [open, connectionId]);

  async function make() {
    setWorking(true);
    setError(null);
    try {
      const names = scope === "*" ? (schemas ?? []) : [scope];
      const refs: TableRef[] = [];
      for (const schema of names) {
        const tables = await getTables(connectionId, schema);
        if (!tables.ok) throw new Error(tables.error.message);
        for (const t of tables.data) refs.push({ schema: t.schema, name: t.name });
        if (refs.length > DOC_MAX_TABLES) {
          throw new Error(
            `This is more than ${DOC_MAX_TABLES.toLocaleString("en-US")} tables. Choose one schema at a time.`,
          );
        }
      }
      if (refs.length === 0) throw new Error("There are no tables to describe here.");
      const entries: TableDetailsEntry[] = [];
      for (let at = 0; at < refs.length; at += CHUNK) {
        const details = await getTablesDetails(connectionId, refs.slice(at, at + CHUNK));
        if (!details.ok) throw new Error(details.error.message);
        entries.push(...details.data);
      }
      const relationships = await getRelationships(connectionId);
      if (!relationships.ok) throw new Error(relationships.error.message);
      const file = generateDoc(format, {
        tables: entries,
        relationships: relationships.data,
        title: scope === "*" ? title : `${title} ${scope}`,
      });
      save(file.fileName, file.text, file.mimeType);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The file could not be made.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !working && onOpenChange(next)}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>Export documentation</DialogTitle>
          <DialogDescription>
            Writes the structure of the database as a document or a diagram you can keep, paste or
            commit.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="docs-scope" className="text-sm font-medium">
              What to describe
            </label>
            <select
              id="docs-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="*">All schemas</option>
              {(schemas ?? []).map((s) => (
                <option key={s} value={s}>
                  Schema {s}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Format</legend>
            {DOC_FORMATS.map((f) => (
              <label key={f} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="docs-format"
                  value={f}
                  checked={format === f}
                  onChange={() => setFormat(f)}
                  className="mt-0.5"
                />
                <span className="flex flex-col">
                  <span className="font-medium">{FORMAT_LABEL[f].name}</span>
                  <span className="text-xs text-muted-foreground">{FORMAT_LABEL[f].note}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div
            role="note"
            className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-50"
          >
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>
              The file holds <strong>table, column, key and index names</strong> with their types,
              which can reveal how your system works. It holds no row of any table (a column&apos;s
              default, a check rule or a comment is included in the document and can hold a
              literal), and nothing is uploaded: it is made and saved on this computer. A text
              diagram is often pasted into an online tool: check where before you do.
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={working} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={working || schemas === null} onClick={() => void make()}>
            {working ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Download aria-hidden="true" />
            )}
            Save file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
