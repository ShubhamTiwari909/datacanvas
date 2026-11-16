/**
 * Where the reader is in a table, as a small state machine with no React in it.
 *
 * The server pages by an opaque cursor that only goes FORWARD, so to offer
 * "Previous" the browser keeps the cursors of the pages it has already shown (the
 * trail). The state also holds the page size, the sort, and the names of masked
 * columns the person chose to reveal. It holds NO row data: rows live in the
 * component that shows them and are dropped with it.
 */
import { ROWS_DEFAULT_PAGE_SIZE, type RowSort } from "@datacanvas/database-core";

export const PAGE_SIZES = [25, 50, 100, 200] as const;

export interface PagingState {
  pageSize: number;
  /** The cursor of every page shown so far, oldest first. The first page has no cursor (null). */
  trail: Array<string | null>;
  /** Masked columns to read for this view (kept in memory only, forgotten with the view). */
  reveal: string[];
  /** Sort by one column; null for the key order. */
  sort: RowSort | null;
}

export type PagingAction =
  | { type: "next"; cursor: string }
  | { type: "previous" }
  | { type: "first" }
  | { type: "pageSize"; pageSize: number }
  | { type: "reveal"; column: string }
  | { type: "hide"; column: string }
  | { type: "sort"; sort: RowSort | null };

export const initialPaging = (pageSize = ROWS_DEFAULT_PAGE_SIZE): PagingState => ({
  pageSize,
  trail: [null],
  reveal: [],
  sort: null,
});

export function pagingReducer(state: PagingState, action: PagingAction): PagingState {
  switch (action.type) {
    case "next":
      return { ...state, trail: [...state.trail, action.cursor] };
    case "previous":
      return state.trail.length > 1 ? { ...state, trail: state.trail.slice(0, -1) } : state;
    case "first":
      return { ...state, trail: [null] };
    case "pageSize":
      // A different page size changes where every page starts: begin again.
      return (PAGE_SIZES as readonly number[]).includes(action.pageSize) &&
        action.pageSize !== state.pageSize
        ? { ...state, pageSize: action.pageSize, trail: [null] }
        : state;
    case "reveal":
      return state.reveal.includes(action.column)
        ? state
        : { ...state, reveal: [...state.reveal, action.column] };
    case "hide": {
      const reveal = state.reveal.filter((c) => c !== action.column);
      // A hidden column cannot be sorted by, so a sort on it goes with it; the order changes, so start again.
      return state.sort?.column === action.column
        ? { ...state, reveal, sort: null, trail: [null] }
        : { ...state, reveal };
    }
    case "sort":
      // A cursor made for one order means nothing under another: begin again from the first page.
      return sameSort(state.sort, action.sort)
        ? state
        : { ...state, sort: action.sort, trail: [null] };
  }
}

const sameSort = (a: RowSort | null, b: RowSort | null): boolean =>
  a === b || (a !== null && b !== null && a.column === b.column && a.direction === b.direction);

/** The cursor of the page being shown. */
export const currentCursor = (state: PagingState): string | null =>
  state.trail[state.trail.length - 1] ?? null;

/** 1 for the first page. */
export const pageNumber = (state: PagingState): number => state.trail.length;

export const canGoBack = (state: PagingState): boolean => state.trail.length > 1;
