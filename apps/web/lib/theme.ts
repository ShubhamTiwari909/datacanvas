/**
 * Light / dark / system theme: the pure parts (no React, no store), so they can
 * be tested without a browser.
 *
 * The choice is remembered in this browser only (`localStorage`); it is never
 * sent anywhere. "system" follows the operating system's setting and changes
 * with it. The theme is a class on `<html>`: Tailwind's `dark:` variant and the
 * `.dark` palette in globals.css both key off it.
 */
export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "datacanvas-theme";
export const THEME_CHOICES: ThemePreference[] = ["light", "dark", "system"];

/** Anything stored that is not one of the three choices means "system". */
export function parseTheme(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

/** The minimum of `Storage` that is used, so tests can pass a plain object. */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Read the saved choice. Storage can throw (blocked, private window): then it is "system". */
export function readStoredTheme(storage?: ThemeStorage): ThemePreference {
  try {
    return parseTheme((storage ?? window.localStorage).getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** Remember the choice. Failing to save is not an error: the theme still applies for this visit. */
export function storeTheme(preference: ThemePreference, storage?: ThemeStorage): void {
  try {
    (storage ?? window.localStorage).setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage unavailable: the choice lasts until the page is closed.
  }
}

/** The part of `<html>` that is touched. */
export interface ThemeRoot {
  classList: { toggle(name: string, force: boolean): unknown };
  style: { colorScheme: string };
}

/** Put the resolved theme on the page: the `dark` class and the matching native `color-scheme`. */
export function applyResolvedTheme(
  resolved: ResolvedTheme,
  root: ThemeRoot = document.documentElement,
): void {
  root.classList.toggle("dark", resolved === "dark");
  // Native controls (scrollbars, <select> lists) follow this.
  root.style.colorScheme = resolved;
}

/**
 * A tiny script that runs in `<head>` BEFORE the page is painted and applies
 * the saved theme, so a dark-mode user never sees a white flash while React
 * loads. It is a fixed string built from constants (no user input), and it
 * does the same as `readStoredTheme` + `resolveTheme` + `applyResolvedTheme`;
 * a test runs it against stand-ins to keep the two in step.
 */
export const NO_FLASH_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var d=s==="dark"||(s!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
