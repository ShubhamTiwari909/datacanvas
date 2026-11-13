/**
 * VIEW settings of each canvas: filters, focus mode, the inspector.
 *
 * Deliberately separate from the canvas store: that one holds the LAYOUT (what a
 * saved workspace contains), this one holds how the user is currently LOOKING at
 * it. Filters and focus are temporary lenses, not part of the layout, so they
 * are not saved and reset when DataCanvas restarts.
 */
import {
  ALL_RELATIONSHIP_TYPES,
  DEFAULT_FILTERS,
  type CanvasFilters,
  type Direction,
  type RelationshipTypeFilter,
} from "@datacanvas/canvas-engine";
import { create } from "zustand";

/**
 * Focus mode: with tables selected, de-emphasise or hide everything that is not
 * within `hops` relationships of them.
 *   off:  everything is shown normally;
 *   dim:  unrelated tables fade out;
 *   hide: unrelated tables disappear.
 */
export interface FocusState {
  mode: "off" | "dim" | "hide";
  hops: number;
  direction: Direction;
}

export interface CanvasViewState {
  filters: CanvasFilters;
  relationshipTypes: RelationshipTypeFilter;
  focus: FocusState;
  inspectorOpen: boolean;
}

export const DEFAULT_VIEW: CanvasViewState = {
  filters: DEFAULT_FILTERS,
  relationshipTypes: ALL_RELATIONSHIP_TYPES,
  focus: { mode: "off", hops: 1, direction: "both" },
  inspectorOpen: true,
};

export const MAX_FOCUS_HOPS = 5;

interface CanvasViewStore {
  views: Record<string, CanvasViewState | undefined>;
  toggleSchema: (connectionId: string, schema: string) => void;
  setShowViews: (connectionId: string, show: boolean) => void;
  hideTables: (connectionId: string, ids: readonly string[]) => void;
  showAllTables: (connectionId: string) => void;
  setRelationshipType: (
    connectionId: string,
    type: keyof RelationshipTypeFilter,
    shown: boolean,
  ) => void;
  setFocus: (connectionId: string, focus: Partial<FocusState>) => void;
  setInspectorOpen: (connectionId: string, open: boolean) => void;
  resetFilters: (connectionId: string) => void;
  dropConnection: (connectionId: string) => void;
}

/** The view of a connection, or the defaults. Returns the SAME object each time for the defaults (stable for selectors). */
export const viewOf = (
  views: Record<string, CanvasViewState | undefined>,
  connectionId: string,
): CanvasViewState => views[connectionId] ?? DEFAULT_VIEW;

export const useCanvasViewStore = create<CanvasViewStore>((set) => {
  const update = (connectionId: string, change: (view: CanvasViewState) => CanvasViewState): void =>
    set((state) => ({
      views: { ...state.views, [connectionId]: change(viewOf(state.views, connectionId)) },
    }));

  return {
    views: {},

    toggleSchema(connectionId, schema) {
      update(connectionId, (view) => {
        const hidden = view.filters.hiddenSchemas;
        const next = hidden.includes(schema)
          ? hidden.filter((s) => s !== schema)
          : [...hidden, schema];
        return { ...view, filters: { ...view.filters, hiddenSchemas: next } };
      });
    },

    setShowViews(connectionId, show) {
      update(connectionId, (view) => ({ ...view, filters: { ...view.filters, showViews: show } }));
    },

    hideTables(connectionId, ids) {
      update(connectionId, (view) => ({
        ...view,
        filters: { ...view.filters, hiddenIds: [...new Set([...view.filters.hiddenIds, ...ids])] },
      }));
    },

    showAllTables(connectionId) {
      update(connectionId, (view) => ({ ...view, filters: { ...view.filters, hiddenIds: [] } }));
    },

    setRelationshipType(connectionId, type, shown) {
      update(connectionId, (view) => ({
        ...view,
        relationshipTypes: { ...view.relationshipTypes, [type]: shown },
      }));
    },

    setFocus(connectionId, focus) {
      update(connectionId, (view) => {
        const merged = { ...view.focus, ...focus };
        return {
          ...view,
          focus: {
            ...merged,
            hops: Math.min(Math.max(Math.trunc(merged.hops), 1), MAX_FOCUS_HOPS),
          },
        };
      });
    },

    setInspectorOpen(connectionId, open) {
      update(connectionId, (view) => ({ ...view, inspectorOpen: open }));
    },

    resetFilters(connectionId) {
      update(connectionId, (view) => ({
        ...view,
        filters: DEFAULT_FILTERS,
        relationshipTypes: ALL_RELATIONSHIP_TYPES,
        focus: DEFAULT_VIEW.focus,
      }));
    },

    dropConnection(connectionId) {
      set((state) => {
        const rest = { ...state.views };
        delete rest[connectionId];
        return { views: rest };
      });
    },
  };
});
