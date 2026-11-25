import type { TableEditInfo } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { MODE_DEFAULT, keyLabel, modeReducer, resolveMode, type ModeState } from "./import-mode";

const info = (uniqueKeys?: TableEditInfo["uniqueKeys"]) =>
  ({
    table: { schema: "public", name: "stock" },
    editable: true,
    reason: null,
    key: ["sku"],
    columns: [],
    triggers: [],
    rowSecurity: false,
    incomingForeignKeys: [],
    ...(uniqueKeys ? { uniqueKeys } : {}),
  }) as unknown as TableEditInfo;

const keys = [
  { name: "stock_pkey", columns: ["sku"] },
  { name: "stock_code_key", columns: ["code"] },
  { name: "stock_pair_key", columns: ["shop", "bin"] },
];
const mapping = ["sku", "code", "name", null, "qty", "shop", "note"];

describe("modeReducer and resolveMode", () => {
  it("adds new rows only by default", () => {
    const resolved = resolveMode(MODE_DEFAULT, info(keys), mapping);
    expect(resolved.offered).toBe(true);
    expect(resolved.key).toBeNull();
    expect(resolved.choice).toEqual({ mode: "insert", key: null, updateColumns: [] });
  });

  it("offers no key mode when the table has no key an import can use, whatever was chosen", () => {
    const upsert = modeReducer(MODE_DEFAULT, { type: "mode", mode: "upsert" });
    for (const table of [info(), info([])]) {
      const resolved = resolveMode(upsert, table, mapping);
      expect(resolved.offered).toBe(false);
      expect(resolved.choice.mode).toBe("insert");
    }
  });

  it("takes the first key (the primary key) by default, and ticks every mapped column outside every key", () => {
    const upsert = modeReducer(MODE_DEFAULT, { type: "mode", mode: "upsert" });
    const resolved = resolveMode(upsert, info(keys), mapping);
    expect(resolved.key).toEqual(keys[0]);
    // code and shop are columns of other keys: the server refuses to update them, so they are not offered.
    expect(resolved.updatable).toEqual(["name", "qty", "note"]);
    expect(resolved.choice).toEqual({
      mode: "upsert",
      key: ["sku"],
      updateColumns: ["name", "qty", "note"],
    });
  });

  it("keeps the columns unticked, and a column mapped later is ticked", () => {
    let state: ModeState = modeReducer(MODE_DEFAULT, { type: "mode", mode: "upsert" });
    state = modeReducer(state, { type: "column", column: "qty", checked: false });
    expect(resolveMode(state, info(keys), mapping).choice.updateColumns).toEqual(["name", "note"]);
    expect(resolveMode(state, info(keys), [...mapping, "colour"]).choice.updateColumns).toEqual([
      "name",
      "note",
      "colour",
    ]);
    state = modeReducer(state, { type: "column", column: "qty", checked: true });
    expect(resolveMode(state, info(keys), mapping).choice.updateColumns).toEqual([
      "name",
      "qty",
      "note",
    ]);
  });

  it("leaves existing rows as they are: no column is updated", () => {
    let state = modeReducer(MODE_DEFAULT, { type: "mode", mode: "upsert" });
    state = modeReducer(state, { type: "leave_existing", checked: true });
    const resolved = resolveMode(state, info(keys), mapping);
    expect(resolved.updatable).toEqual(["name", "qty", "note"]);
    expect(resolved.choice.updateColumns).toEqual([]);
    state = modeReducer(state, { type: "leave_existing", checked: false });
    expect(resolveMode(state, info(keys), mapping).choice.updateColumns).toHaveLength(3);
  });

  it("another key starts its columns again from all ticked; the same key changes nothing", () => {
    let state = modeReducer(MODE_DEFAULT, { type: "mode", mode: "upsert" });
    state = modeReducer(state, { type: "column", column: "name", checked: false });
    state = modeReducer(state, { type: "leave_existing", checked: true });
    expect(modeReducer(state, { type: "key", name: state.keyName ?? "x" })).not.toBe(state);
    const same = modeReducer(state, { type: "key", name: "stock_code_key" });
    expect(modeReducer(same, { type: "key", name: "stock_code_key" })).toBe(same);
    expect(same).toMatchObject({ keyName: "stock_code_key", unticked: [], leaveExisting: false });
    const resolved = resolveMode(same, info(keys), mapping);
    expect(resolved.choice.key).toEqual(["code"]);
    expect(resolved.choice.updateColumns).toEqual(["name", "qty", "note"]);
  });

  it("an update only has a key and no list of columns", () => {
    let state = modeReducer(MODE_DEFAULT, { type: "mode", mode: "update" });
    state = modeReducer(state, { type: "key", name: "stock_pair_key" });
    const resolved = resolveMode(state, info(keys), mapping);
    expect(resolved.choice).toEqual({ mode: "update", key: ["shop", "bin"], updateColumns: [] });
    expect(resolved.updatable).toEqual([]);
  });

  it("falls back to the first key when the key chosen is no longer offered", () => {
    const state = { ...MODE_DEFAULT, mode: "update" as const, keyName: "gone" };
    expect(resolveMode(state, info(keys), mapping).key).toEqual(keys[0]);
  });

  it("counts the changes of mode and key, so what was found for earlier choices is not brought back", () => {
    let state = modeReducer(MODE_DEFAULT, { type: "mode", mode: "upsert" });
    expect(state.revision).toBe(1);
    state = modeReducer(state, { type: "mode", mode: "insert" });
    state = modeReducer(state, { type: "mode", mode: "upsert" });
    expect(state.revision).toBe(3);
    // The same mode, a column ticked or "leave existing rows" is not a change of mode or key.
    const same = modeReducer(state, { type: "mode", mode: "upsert" });
    expect(same).toBe(state);
    state = modeReducer(state, { type: "column", column: "qty", checked: false });
    state = modeReducer(state, { type: "leave_existing", checked: true });
    expect(state.revision).toBe(3);
    state = modeReducer(state, { type: "key", name: "stock_code_key" });
    expect(state.revision).toBe(4);
  });

  it("names a key by its name and its columns", () => {
    expect(keyLabel(keys[2]!)).toBe("stock_pair_key (shop, bin)");
  });
});
