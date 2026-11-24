/**
 * Choosing rows to EXPORT, with no write unlocked (`docs/insight-release-plan.md`, section 8.1; decision 168): the rows
 * are chosen by the key of the page reader's own ordering (a table with no key cannot be chosen from, and the grid says
 * why), in memory, kept across pages and sorts, and let go of when the table changes. The same pure functions as the
 * choice for a bulk change (`features/writes/bulk-select.ts`) do the work; only the state and the key are different.
 * The rows are never sent as values: the export reads them again by their keys on the server.
 */
import { useMemo, useState } from "react";
import type { KeyValue, RowPage, TableRef } from "@datacanvas/database-core";
import {
  EMPTY_SELECTION,
  pageSelectable,
  pageState,
  togglePage,
  toggleRow,
  type Selection,
} from "@/features/writes/bulk-select";
import type { GridSelection } from "./data-grid";

export interface ExportSelection {
  /** What the grid needs to show a checkbox column, or null when this table cannot be chosen from. */
  selection: GridSelection | null;
  /** The key of each chosen row. */
  keys: KeyValue[][];
  limited: boolean;
  clear: () => void;
}

export function useExportSelection({
  connectionId,
  table,
  page,
}: {
  connectionId: string;
  table: TableRef;
  page: RowPage | null;
}): ExportSelection {
  const tableKey = JSON.stringify([connectionId, table.schema, table.name]);
  const [chosen, setChosen] = useState<{
    table: string;
    rows: Selection;
    anchor: number | null;
    /** The page the anchor is an index of: another page, sort or filter makes it point at another row. */
    anchorPage: unknown;
    limited: boolean;
  }>({ table: tableKey, rows: EMPTY_SELECTION, anchor: null, anchorPage: null, limited: false });
  // Another table or connection: the old choice is dropped, not just hidden.
  if (chosen.table !== tableKey) {
    setChosen({
      table: tableKey,
      rows: EMPTY_SELECTION,
      anchor: null,
      anchorPage: null,
      limited: false,
    });
  }
  const selected = chosen.table === tableKey ? chosen.rows : EMPTY_SELECTION;

  const usable = page !== null && page.order.kind !== "none" && page.order.columns.length > 0;
  const selectable = useMemo(
    () =>
      page && usable
        ? pageSelectable(page, { editable: true, key: page.order.columns, reason: null })
        : [],
    [page, usable],
  );

  const selection = useMemo<GridSelection | null>(() => {
    if (!page || !usable) return null;
    const apply = (next: { selection: Selection; anchor: number | null; limited: boolean }) =>
      setChosen({
        table: tableKey,
        rows: next.selection,
        anchor: next.anchor,
        anchorPage: page,
        limited: next.limited,
      });
    return {
      isSelected: (r) => {
        const row = selectable[r];
        return row !== null && row !== undefined && selectedHas(selected, row.key);
      },
      onToggle: (r, extend) => {
        const anchor = chosen.anchorPage === page ? chosen.anchor : null;
        apply(toggleRow(selected, selectable, r, extend, anchor));
      },
      pageState: pageState(selected, selectable),
      onTogglePage: () => apply(togglePage(selected, selectable)),
    };
  }, [page, usable, selectable, selected, chosen.anchor, chosen.anchorPage, tableKey]);

  return {
    selection,
    keys: [...selected.values()].map((r) => r.key),
    limited: chosen.limited,
    clear: () =>
      setChosen({
        table: tableKey,
        rows: EMPTY_SELECTION,
        anchor: null,
        anchorPage: null,
        limited: false,
      }),
  };
}

const selectedHas = (selection: Selection, key: readonly KeyValue[]): boolean =>
  selection.has(JSON.stringify(key.map((k) => [k.column, k.value])));
