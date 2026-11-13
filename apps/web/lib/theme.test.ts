import { describe, expect, it } from "vitest";
import {
  NO_FLASH_SCRIPT,
  THEME_STORAGE_KEY,
  applyResolvedTheme,
  parseTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  type ThemeRoot,
  type ThemeStorage,
} from "./theme";

const memory = (
  initial: Record<string, string> = {},
): ThemeStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
};
const brokenStorage: ThemeStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};
const fakeRoot = (): ThemeRoot & { classes: Set<string> } => {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      toggle: (name: string, force: boolean) => (force ? classes.add(name) : classes.delete(name)),
    },
    style: { colorScheme: "" },
  };
};

describe("parseTheme", () => {
  it("accepts the three choices and treats anything else as system", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("system")).toBe("system");
    for (const bad of [null, undefined, "", "DARK", "blue", 3, {}]) {
      expect(parseTheme(bad)).toBe("system");
    }
  });
});

describe("resolveTheme", () => {
  it("follows the system only when asked to", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("storage", () => {
  it("stores and reads the choice", () => {
    const storage = memory();
    storeTheme("dark", storage);
    expect(storage.data[THEME_STORAGE_KEY]).toBe("dark");
    expect(readStoredTheme(storage)).toBe("dark");
  });

  it("falls back to system for a missing, damaged or unreadable value", () => {
    expect(readStoredTheme(memory())).toBe("system");
    expect(readStoredTheme(memory({ [THEME_STORAGE_KEY]: "purple" }))).toBe("system");
    expect(readStoredTheme(brokenStorage)).toBe("system");
  });

  it("does not throw when saving is impossible", () => {
    expect(() => storeTheme("dark", brokenStorage)).not.toThrow();
  });
});

describe("applyResolvedTheme", () => {
  it("sets and clears the dark class and the native color scheme", () => {
    const root = fakeRoot();
    applyResolvedTheme("dark", root);
    expect(root.classes.has("dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");
    applyResolvedTheme("light", root);
    expect(root.classes.has("dark")).toBe(false);
    expect(root.style.colorScheme).toBe("light");
  });
});

describe("NO_FLASH_SCRIPT (runs before React)", () => {
  /** Run the script against stand-ins for the browser objects. */
  function run(saved: string | null, systemDark: boolean, storageBroken = false) {
    const root = fakeRoot();
    const localStorage = storageBroken
      ? brokenStorage
      : memory(saved === null ? {} : { [THEME_STORAGE_KEY]: saved });
    const window = { matchMedia: () => ({ matches: systemDark }) };
    new Function("localStorage", "window", "document", NO_FLASH_SCRIPT)(localStorage, window, {
      documentElement: root,
    });
    return root;
  }

  it("agrees with resolveTheme for every combination", () => {
    for (const saved of [null, "light", "dark", "system", "garbage"]) {
      for (const systemDark of [true, false]) {
        const expected = resolveTheme(parseTheme(saved), systemDark);
        const root = run(saved, systemDark);
        expect(root.classes.has("dark"), `${saved}/${systemDark}`).toBe(expected === "dark");
        expect(root.style.colorScheme, `${saved}/${systemDark}`).toBe(expected);
      }
    }
  });

  it("never throws when storage is blocked", () => {
    expect(() => run(null, true, true)).not.toThrow();
  });

  it("contains no user-controlled text", () => {
    expect(NO_FLASH_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(NO_FLASH_SCRIPT).not.toMatch(/<\/?script/i);
  });
});
