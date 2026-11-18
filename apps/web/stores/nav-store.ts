/** Whether the sidebar drawer is open. Only matters below the `md` breakpoint, where the sidebar is a drawer. */
import { create } from "zustand";

interface NavState {
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
}

export const useNavStore = create<NavState>((set) => ({
  drawerOpen: false,
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
}));
