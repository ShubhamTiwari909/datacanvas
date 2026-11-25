/**
 * The import dialog's choice of what happens to rows already in the table (`docs/write-side-v2-plan.md`, 4.1 and
 * 4.2): the mode, the key and the columns to update, as a reducer the dialog runs with `useReducer`, and what the
 * choices come to for a table and a mapping. Pure functions, no React.
 *
 * The two key modes are offered only when the table has a key an import may use (`TableEditInfo.uniqueKeys`: the
 * primary key and unique constraints that are not partial, not deferrable, with every column NOT NULL). The columns
 * to update are kept as the ones the person UNTICKED, so a column mapped later is ticked by default.
 */
import type { TableEditInfo, UniqueKeyInfo } from "@datacanvas/database-core";
import type { ImportChoice, ImportMode } from "./import-plan";

export interface ModeState {
  mode: ImportMode;
  /** The key chosen by its constraint's name; null for the first one offered (the primary key, when there is one). */
  keyName: string | null;
  /** Columns the person unticked in "Columns to update". */
  unticked: readonly string[];
  /** "Leave existing rows as they are": no column is updated (`DO NOTHING`). */
  leaveExisting: boolean;
  /**
   * Counts the changes of mode or key. What was found for the earlier choices (the validation's answer, the rows
   * left out) is keyed with it, so it is dropped and not brought back by choosing the same mode and key again.
   */
  revision: number;
}

export const MODE_DEFAULT: ModeState = {
  mode: "insert",
  keyName: null,
  unticked: [],
  leaveExisting: false,
  revision: 0,
};

export type ModeAction =
  | { type: "mode"; mode: ImportMode }
  | { type: "key"; name: string }
  | { type: "column"; column: string; checked: boolean }
  | { type: "leave_existing"; checked: boolean };

/** The next state. Another key starts its columns to update again from all ticked. */
export function modeReducer(state: ModeState, action: ModeAction): ModeState {
  switch (action.type) {
    case "mode":
      return action.mode === state.mode
        ? state
        : { ...state, mode: action.mode, revision: state.revision + 1 };
    case "key":
      return action.name === state.keyName
        ? state
        : {
            ...state,
            keyName: action.name,
            unticked: [],
            leaveExisting: false,
            revision: state.revision + 1,
          };
    case "column": {
      const rest = state.unticked.filter((c) => c !== action.column);
      return { ...state, unticked: action.checked ? rest : [...rest, action.column] };
    }
    case "leave_existing":
      return { ...state, leaveExisting: action.checked };
  }
}

/** The keys an import may use, as the server lists them (the primary key first). */
export const keysOf = (info: TableEditInfo): readonly UniqueKeyInfo[] => info.uniqueKeys ?? [];

/** What the choices come to for this table and mapping. */
export interface ResolvedMode {
  /** Whether the key modes can be chosen (the table has a key an import may use). */
  offered: boolean;
  keys: readonly UniqueKeyInfo[];
  /** The key in use; null in insert mode. */
  key: UniqueKeyInfo | null;
  /** Upsert: the mapped columns that may be updated (outside every key the table offers), in the mapping's order. */
  updatable: string[];
  choice: ImportChoice;
}

export function resolveMode(
  state: ModeState,
  info: TableEditInfo,
  mapping: ReadonlyArray<string | null>,
): ResolvedMode {
  const keys = keysOf(info);
  const offered = keys.length > 0;
  const mode: ImportMode = offered ? state.mode : "insert";
  const key =
    mode === "insert" ? null : (keys.find((k) => k.name === state.keyName) ?? keys[0] ?? null);
  const mapped = [...new Set(mapping.filter((m): m is string => m !== null))];
  // A column of any key is never updated: the server refuses it (another key would conflict, or a key would move).
  const updatable =
    mode === "upsert" && key !== null
      ? mapped.filter((c) => !key.columns.includes(c) && !keys.some((k) => k.columns.includes(c)))
      : [];
  const updateColumns = state.leaveExisting
    ? []
    : updatable.filter((c) => !state.unticked.includes(c));
  return {
    offered,
    keys,
    key,
    updatable,
    choice: { mode, key: key ? key.columns : null, updateColumns },
  };
}

/** A key as the select names it: its name and its columns. */
export function keyLabel(key: UniqueKeyInfo): string {
  return `${key.name} (${key.columns.join(", ")})`;
}
