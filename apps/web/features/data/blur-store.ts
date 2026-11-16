/**
 * "Blur values": a view preference for screen sharing. Held in memory only (it
 * starts off in every new page load) and shared by every table, so switching
 * tables does not suddenly show values again. It holds a boolean and no row.
 */
import { create } from "zustand";

interface BlurState {
  blurred: boolean;
  setBlurred: (blurred: boolean) => void;
}

export const useBlurStore = create<BlurState>((set) => ({
  blurred: false,
  setBlurred: (blurred) => set({ blurred }),
}));

/** Classes that hide a value from view but leave it in place, unselectable so it cannot be dragged out. */
export const BLUR_CLASSES = "blur-sm select-none";

/**
 * The same, for the grid: applied by the wrapper's `data-blurred` attribute, so
 * switching it re-renders no cell (a wide page has thousands).
 */
export const BLUR_IN_GRID =
  "group-data-[blurred=true]/grid:blur-sm group-data-[blurred=true]/grid:select-none";
