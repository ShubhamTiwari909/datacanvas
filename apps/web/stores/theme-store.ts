/**
 * The theme the user chose and the theme actually shown.
 *
 * `preference` is what was chosen (light, dark or system); `resolved` is what
 * that means right now (light or dark), which is what components such as the
 * canvas need. `init()` runs once after the page loads: it reads the saved
 * choice, applies it and keeps "system" in step with the operating system.
 * (The class is already on <html> by then, put there by the inline script in
 * the layout before the first paint; `init` only brings this store in line.)
 */
import { create } from "zustand";
import {
  applyResolvedTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches;
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  /** Read the saved choice, apply it, follow the system. Returns the cleanup function. */
  init: () => () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  // What the server renders; `init()` replaces it with the real values in the browser.
  preference: "system",
  resolved: "light",

  setPreference(preference) {
    storeTheme(preference);
    const resolved = resolveTheme(preference, systemPrefersDark());
    applyResolvedTheme(resolved);
    set({ preference, resolved });
  },

  init() {
    const preference = readStoredTheme();
    const resolved = resolveTheme(preference, systemPrefersDark());
    applyResolvedTheme(resolved);
    set({ preference, resolved });

    const media = window.matchMedia(DARK_QUERY);
    const onChange = (): void => {
      // Only "system" follows the operating system; an explicit choice stays.
      if (get().preference !== "system") return;
      const next = resolveTheme("system", media.matches);
      applyResolvedTheme(next);
      set({ resolved: next });
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  },
}));
