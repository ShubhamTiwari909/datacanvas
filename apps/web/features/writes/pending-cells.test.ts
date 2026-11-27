import { describe, expect, it } from "vitest";
import {
  EDIT_CELLS_MAX_CELLS,
  EDIT_CELLS_MAX_CELLS_PER_ROW,
  MAX_BULK_ROWS,
  type EditableColumn,
  type KeyValue,
} from "@datacanvas/database-core";
import { editCellsChangeSchema } from "@datacanvas/shared-types";
import { rowSignature } from "./bulk-select";
import { IMPORT_MAX_BODY_BYTES } from "@datacanvas/shared-types";
import {
  BODY_LIMIT_TEXT,
  CELLS_LIMIT_TEXT,
  EMPTY_PENDING,
  KEY_CELL_TEXT,
  ROWS_LIMIT_TEXT,
  ROW_CELLS_LIMIT_TEXT,
  appliedCellsText,
  buildEditCells,
  cellsWritten,
  countPending,
  gridCellBlock,
  keyLabel,
  pendingBySignature,
  pendingReducer,
  pendingText,
  pendingTextSize,
  type PendingAction,
  type PendingState,
} from "./pending-cells";

const key = (id: number | string): KeyValue[] => [{ column: "id", value: String(id) }];
const set = (
  id: number | string,
  column: string,
  before: string | null,
  after: string | null,
): PendingAction => ({ type: "set", key: key(id), column, before, after });
const run = (actions: PendingAction[], from: PendingState = EMPTY_PENDING): PendingState =>
  actions.reduce(pendingReducer, from);
/** The pending cells as [id, column, before, after], in order. */
const cells = (state: PendingState) =>
  state.rows.flatMap((r) =>
    r.cells.map((c) => [r.key[0]!.value, c.column, c.before, c.after] as const),
  );
const table = { schema: "public", name: "items" };

describe("pending cells", () => {
  it("sets cells, keeps the value first seen, and counts cells and rows", () => {
    const state = run([
      set(1, "name", "ann", "anne"),
      set(2, "qty", "5", "6"),
      // Edited again: the value first seen stays what the change is checked against.
      set(1, "name", "anne", "annie"),
      set(1, "note", null, ""),
    ]);
    expect(cells(state)).toEqual([
      ["1", "name", "ann", "annie"],
      ["1", "note", null, ""],
      ["2", "qty", "5", "6"],
    ]);
    expect(countPending(state)).toEqual({ cells: 3, rows: 2 });
    expect(pendingText(countPending(state))).toBe("3 cells in 2 rows changed");
    expect(pendingText({ cells: 1, rows: 1 })).toBe("1 cell in 1 row changed");
    expect(pendingText({ cells: 2500, rows: 500 })).toBe("2,500 cells in 500 rows changed");
    expect(pendingBySignature(state).get(rowSignature(key(1)))?.cells).toHaveLength(2);
  });

  it("keeps NULL apart from the empty string", () => {
    expect(cells(run([set(1, "note", null, "")]))).toEqual([["1", "note", null, ""]]);
    expect(cells(run([set(1, "note", "", null)]))).toEqual([["1", "note", "", null]]);
    expect(run([set(1, "note", null, null)])).toEqual(EMPTY_PENDING);
  });

  it("removes a cell edited back to the value first seen, and the row with its last cell", () => {
    const state = run([
      set(1, "name", "ann", "anne"),
      set(1, "qty", "1", "2"),
      set(1, "name", "anne", "ann"),
    ]);
    expect(cells(state)).toEqual([["1", "qty", "1", "2"]]);
    const none = run([set(1, "qty", "2", "1")], state);
    expect(none.rows).toEqual([]);
    expect(countPending(none)).toEqual({ cells: 0, rows: 0 });
  });

  it("does nothing (and no undo step) for an edit that changes nothing", () => {
    const state = run([set(1, "name", "ann", "anne")]);
    expect(run([set(1, "name", "anne", "anne")], state)).toBe(state);
    expect(run([set(2, "name", "bob", "bob")], state)).toBe(state);
  });

  it("undoes each step in turn, back to nothing pending", () => {
    const steps: PendingAction[] = [
      set(1, "name", "ann", "anne"),
      set(2, "qty", "5", "6"),
      set(1, "name", "anne", "annie"),
      set(2, "qty", "6", "5"),
      { type: "revert", signature: rowSignature(key(1)), column: "name" },
    ];
    const states = [EMPTY_PENDING];
    for (const step of steps) states.push(pendingReducer(states.at(-1)!, step));
    let state = states.at(-1)!;
    expect(state.rows).toEqual([]);
    for (let i = states.length - 2; i >= 0; i--) {
      state = pendingReducer(state, { type: "undo" });
      expect(cells(state), `after undoing step ${i + 1}`).toEqual(cells(states[i]!));
    }
    // Nothing left to undo.
    expect(pendingReducer(state, { type: "undo" })).toBe(state);
  });

  it("takes one cell back from the review, and ignores a cell that is not pending", () => {
    const state = run([set(1, "name", "ann", "anne"), set(1, "qty", "1", "2")]);
    const after = pendingReducer(state, {
      type: "revert",
      signature: rowSignature(key(1)),
      column: "qty",
    });
    expect(cells(after)).toEqual([["1", "name", "ann", "anne"]]);
    expect(pendingReducer(after, { type: "revert", signature: "nope", column: "qty" })).toBe(after);
  });

  it("discards everything, with nothing left to undo", () => {
    const state = run([set(1, "name", "ann", "anne"), { type: "discard" }]);
    expect(state).toEqual(EMPTY_PENDING);
    expect(pendingReducer(state, { type: "undo" })).toEqual(EMPTY_PENDING);
  });

  it("drops the cells of columns that are hidden again, and their undo steps", () => {
    const state = run([set(1, "api_token", "t", "u"), set(1, "name", "a", "b")]);
    const pruned = pendingReducer(state, { type: "prune", keep: (c) => c !== "api_token" });
    expect(cells(pruned)).toEqual([["1", "name", "a", "b"]]);
    expect(pendingReducer(pruned, { type: "undo" }).rows).toEqual([]);
    expect(pendingReducer(pruned, { type: "prune", keep: () => true })).toBe(pruned);
  });

  it(`keeps at most ${MAX_BULK_ROWS} rows, and says so`, () => {
    const full = run(Array.from({ length: MAX_BULK_ROWS }, (_, i) => set(i + 1, "qty", "0", "1")));
    expect(countPending(full)).toEqual({ cells: MAX_BULK_ROWS, rows: MAX_BULK_ROWS });
    const refused = run([set(MAX_BULK_ROWS + 1, "qty", "0", "1")], full);
    expect(refused.rows).toBe(full.rows);
    expect(refused.refusal).toBe(ROWS_LIMIT_TEXT);
    expect(ROWS_LIMIT_TEXT).toBe(
      "At most 500 rows can be edited in one change. Review and apply these first.",
    );
    // A row already pending can still be changed, and the refusal goes with the next edit that is kept.
    const more = run([set(1, "name", "a", "b")], refused);
    expect(more.refusal).toBeNull();
    expect(countPending(more)).toEqual({ cells: MAX_BULK_ROWS + 1, rows: MAX_BULK_ROWS });
  });

  it(`keeps at most ${EDIT_CELLS_MAX_CELLS_PER_ROW} cells in a row`, () => {
    const full = run(
      Array.from({ length: EDIT_CELLS_MAX_CELLS_PER_ROW }, (_, c) => set(1, `c${c}`, null, "x")),
    );
    const refused = run([set(1, "c-last", null, "x")], full);
    expect(refused.refusal).toBe(ROW_CELLS_LIMIT_TEXT);
    expect(countPending(refused).cells).toBe(EDIT_CELLS_MAX_CELLS_PER_ROW);
    // Another row is fine, and so is changing a cell already pending.
    expect(run([set(2, "c-last", null, "x")], refused).refusal).toBeNull();
    expect(cells(run([set(1, "c0", "x", "y")], refused))[0]).toEqual(["1", "c0", null, "y"]);
  });

  it(`keeps at most ${EDIT_CELLS_MAX_CELLS.toLocaleString("en-US")} cells in all`, () => {
    const perRow = EDIT_CELLS_MAX_CELLS_PER_ROW;
    const fullRows = EDIT_CELLS_MAX_CELLS / perRow;
    let state = EMPTY_PENDING;
    for (let r = 0; r < fullRows; r++) {
      for (let c = 0; c < perRow; c++) state = pendingReducer(state, set(r, `c${c}`, null, "x"));
    }
    expect(countPending(state)).toEqual({ cells: EDIT_CELLS_MAX_CELLS, rows: fullRows });
    const refused = pendingReducer(state, set(fullRows, "c0", null, "x"));
    expect(refused.refusal).toBe(CELLS_LIMIT_TEXT);
    expect(CELLS_LIMIT_TEXT).toBe(
      "At most 2,500 cells can be edited in one change. Review and apply these first.",
    );
    expect(countPending(refused).cells).toBe(EDIT_CELLS_MAX_CELLS);
    // Taking one back makes room again.
    const room = run(
      [
        { type: "revert", signature: rowSignature(key(0)), column: "c0" },
        set(fullRows, "c0", null, "x"),
      ],
      refused,
    );
    expect(room.refusal).toBeNull();
    expect(countPending(room)).toEqual({ cells: EDIT_CELLS_MAX_CELLS, rows: fullRows + 1 });
  });

  it("builds the edit_cells change the server's schema accepts, with what was seen as expected", () => {
    expect(buildEditCells(table, EMPTY_PENDING, [])).toBeNull();
    const state = run([
      set(1, "name", "ann", "anne"),
      set(2, "note", "x", null),
      set(1, "api_token", "t", ""),
    ]);
    const change = buildEditCells(table, state, ["api_token"])!;
    expect(change).toEqual({
      kind: "edit_cells",
      table,
      revealColumns: ["api_token"],
      rows: [
        {
          key: key(1),
          changes: [
            { column: "name", value: "anne", expected: "ann" },
            { column: "api_token", value: "", expected: "t" },
          ],
        },
        { key: key(2), changes: [{ column: "note", value: null, expected: "x" }] },
      ],
    });
    expect(editCellsChangeSchema.safeParse(change).success).toBe(true);
  });

  it("builds a change of the largest size the schema accepts", () => {
    let state = EMPTY_PENDING;
    for (let r = 0; r < MAX_BULK_ROWS; r++) {
      for (let c = 0; c < EDIT_CELLS_MAX_CELLS / MAX_BULK_ROWS; c++) {
        state = pendingReducer(state, set(r, `c${c}`, null, "x"));
      }
    }
    expect(state.refusal).toBeNull();
    const change = buildEditCells(table, state, [])!;
    expect(change.rows).toHaveLength(MAX_BULK_ROWS);
    expect(editCellsChangeSchema.safeParse(change).success).toBe(true);
  });

  it("says why a cell cannot be edited in the grid: row, key, hidden, filled by the database, bytea, cut", () => {
    const column = (over: Partial<EditableColumn> = {}): EditableColumn => ({
      name: "c",
      dataType: "text",
      nullable: true,
      hasDefault: false,
      generated: false,
      identity: null,
      editable: true,
      inKey: false,
      ...over,
    });
    const shown = { name: "c", masked: false };
    const cell = { value: "x", truncated: false };
    expect(gridCellBlock(null, shown, cell, column())).toBeNull();
    expect(gridCellBlock("No key.", shown, cell, column())).toBe("No key.");
    expect(gridCellBlock(null, shown, cell, column({ inKey: true }))).toBe(KEY_CELL_TEXT);
    expect(gridCellBlock(null, { name: "c", masked: true }, cell, column())).toBe(
      "This column is hidden. Show it first to edit it.",
    );
    expect(gridCellBlock(null, shown, cell, column({ generated: true }))).toBe(
      "The database fills this column.",
    );
    expect(gridCellBlock(null, shown, cell, column({ editable: false, dataType: "bytea" }))).toBe(
      "Values of this type cannot be edited here.",
    );
    expect(gridCellBlock(null, shown, { value: "x", truncated: true }, column())).toBe(
      "Only part of this value was read, so it cannot be edited here.",
    );
    expect(gridCellBlock(null, shown, cell, undefined)).toBe("This column cannot be edited here.");
  });

  it("names rows by their key and counts the cells written without the rows left out", () => {
    expect(keyLabel(key(3))).toBe("id 3");
    expect(
      keyLabel([
        { column: "a", value: "1" },
        { column: "b", value: "x" },
      ]),
    ).toBe("a 1, b x");
    const change = buildEditCells(
      table,
      run([set(1, "a", "1", "2"), set(1, "b", "1", "2"), set(2, "a", "1", "2")]),
      [],
    )!;
    expect(cellsWritten(change, [])).toBe(3);
    expect(cellsWritten(change, [0])).toBe(1);
    expect(appliedCellsText(1)).toBe("1 cell was changed.");
    expect(appliedCellsText(2500)).toBe("2,500 cells were changed.");
  });
});

describe("the size of the text one change carries", () => {
  const set = (id: number, before: string, after: string): PendingAction => ({
    type: "set",
    key: key(id),
    column: "bio",
    before,
    after,
  });

  it("counts every new value and every value seen, and refuses a cell that would pass the body limit", () => {
    // Two cells of 100,000 characters (new value plus the value seen: 200,000) are 4.2 MB per 21 cells.
    let state: PendingState = EMPTY_PENDING;
    const half = "x".repeat(100_000);
    let refused = false;
    for (let id = 1; id <= 200 && !refused; id++) {
      const next = pendingReducer(state, set(id, half, `${half}y`.slice(1)));
      refused = next.refusal === BODY_LIMIT_TEXT;
      if (!refused) state = next;
    }
    // The change was refused by size before the cell limit of the change.
    expect(IMPORT_MAX_BODY_BYTES).toBe(32 * 1024 * 1024);
    expect(refused).toBe(true);
    expect(pendingTextSize(state.rows)).toBeLessThanOrEqual(IMPORT_MAX_BODY_BYTES);
    expect(pendingTextSize(state.rows)).toBeGreaterThan(IMPORT_MAX_BODY_BYTES - 200_000);
    expect(BODY_LIMIT_TEXT).toContain("32 MB");
  });

  it("is zero for nothing, and counts NULL as nothing", () => {
    expect(pendingTextSize([])).toBe(0);
    const state = pendingReducer(EMPTY_PENDING, {
      type: "set",
      key: key(1),
      column: "bio",
      before: null,
      after: "abc",
    });
    expect(pendingTextSize(state.rows)).toBe(3);
  });
});
