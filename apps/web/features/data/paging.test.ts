import { describe, expect, it } from "vitest";
import {
  PAGE_SIZES,
  canGoBack,
  currentCursor,
  initialPaging,
  pageNumber,
  pagingReducer,
  type PagingAction,
  type PagingState,
} from "./paging";

const run = (actions: PagingAction[], from: PagingState = initialPaging()): PagingState =>
  actions.reduce(pagingReducer, from);

describe("paging", () => {
  it("starts on the first page, 50 rows, nothing revealed, with no cursor", () => {
    const state = initialPaging();
    expect(state).toEqual({
      pageSize: 50,
      trail: [null],
      reveal: [],
      sort: null,
      filters: [],
    });
    expect(currentCursor(state)).toBeNull();
    expect(pageNumber(state)).toBe(1);
    expect(canGoBack(state)).toBe(false);
  });

  it("goes forward with the cursor the server gave, and back to the pages it has seen", () => {
    const two = run([{ type: "next", cursor: "c1" }]);
    expect(currentCursor(two)).toBe("c1");
    expect(pageNumber(two)).toBe(2);
    expect(canGoBack(two)).toBe(true);

    const three = pagingReducer(two, { type: "next", cursor: "c2" });
    expect(pageNumber(three)).toBe(3);

    const back = pagingReducer(three, { type: "previous" });
    expect(currentCursor(back)).toBe("c1");
    expect(currentCursor(pagingReducer(back, { type: "previous" }))).toBeNull();
  });

  it("does not go back past the first page", () => {
    const state = initialPaging();
    expect(pagingReducer(state, { type: "previous" })).toBe(state);
  });

  it("returns to the first page", () => {
    const state = run([
      { type: "next", cursor: "c1" },
      { type: "next", cursor: "c2" },
      { type: "first" },
    ]);
    expect(state.trail).toEqual([null]);
  });

  it("begins again when the page size changes, because every page would start somewhere else", () => {
    const state = run([
      { type: "next", cursor: "c1" },
      { type: "pageSize", pageSize: 100 },
    ]);
    expect(state).toMatchObject({ pageSize: 100, trail: [null] });
  });

  it("ignores a page size that is not offered, or is the one already in use", () => {
    const deep = run([{ type: "next", cursor: "c1" }]);
    expect(pagingReducer(deep, { type: "pageSize", pageSize: 7 })).toBe(deep);
    expect(pagingReducer(deep, { type: "pageSize", pageSize: 50 })).toBe(deep);
    expect(PAGE_SIZES).toEqual([25, 50, 100, 200]);
  });

  it("keeps the page when a column is revealed or hidden again", () => {
    const deep = run([{ type: "next", cursor: "c1" }]);
    const shown = pagingReducer(deep, { type: "reveal", column: "api_key" });
    expect(shown.reveal).toEqual(["api_key"]);
    expect(currentCursor(shown)).toBe("c1");
    expect(pagingReducer(shown, { type: "reveal", column: "api_key" })).toBe(shown);
    expect(pagingReducer(shown, { type: "hide", column: "api_key" }).reveal).toEqual([]);
    expect(pagingReducer(shown, { type: "hide", column: "other" }).reveal).toEqual(["api_key"]);
  });

  it("never holds row data: the state is only a size, cursors, a sort and column names", () => {
    const state = run([
      { type: "next", cursor: "c1" },
      { type: "reveal", column: "token" },
      { type: "sort", sort: { column: "email", direction: "desc" } },
    ]);
    expect(Object.keys(state).sort()).toEqual(["filters", "pageSize", "reveal", "sort", "trail"]);
    expect(state.trail.every((c) => c === null || typeof c === "string")).toBe(true);
    expect(state.sort).toEqual({ column: "email", direction: "desc" });
  });
});

describe("a sort in the paging state", () => {
  const byEmail = { column: "email", direction: "asc" as const };

  it("starts with none, and sets one", () => {
    expect(initialPaging().sort).toBeNull();
    expect(run([{ type: "sort", sort: byEmail }]).sort).toEqual(byEmail);
  });

  it("starts again from the first page, because a cursor from one order means nothing under another", () => {
    const deep = run([
      { type: "next", cursor: "c1" },
      { type: "next", cursor: "c2" },
    ]);
    expect(pageNumber(deep)).toBe(3);
    const sorted = pagingReducer(deep, { type: "sort", sort: byEmail });
    expect(pageNumber(sorted)).toBe(1);
    expect(currentCursor(sorted)).toBeNull();
    // ... and removing the sort does too.
    const again = pagingReducer(pagingReducer(sorted, { type: "next", cursor: "c9" }), {
      type: "sort",
      sort: null,
    });
    expect(again.sort).toBeNull();
    expect(pageNumber(again)).toBe(1);
  });

  it("changes nothing, and keeps the page, when the same sort is asked for again", () => {
    const sorted = run([
      { type: "sort", sort: byEmail },
      { type: "next", cursor: "c1" },
    ]);
    expect(pagingReducer(sorted, { type: "sort", sort: { ...byEmail } })).toBe(sorted);
    expect(pagingReducer(initialPaging(), { type: "sort", sort: null })).toEqual(initialPaging());
  });

  it("keeps the sort when the page size changes, and the page size when the sort changes", () => {
    const state = run([
      { type: "sort", sort: byEmail },
      { type: "pageSize", pageSize: 100 },
    ]);
    expect(state.sort).toEqual(byEmail);
    expect(pagingReducer(state, { type: "sort", sort: null }).pageSize).toBe(100);
  });

  it("goes when its column is hidden again (a hidden column cannot be sorted), and starts again", () => {
    const state = run([
      { type: "reveal", column: "token" },
      { type: "sort", sort: { column: "token", direction: "asc" } },
      { type: "next", cursor: "c1" },
    ]);
    const hidden = pagingReducer(state, { type: "hide", column: "token" });
    expect(hidden.sort).toBeNull();
    expect(hidden.reveal).toEqual([]);
    expect(pageNumber(hidden)).toBe(1);
  });

  it("stays, with its page, when another column is hidden again", () => {
    const state = run([
      { type: "reveal", column: "token" },
      { type: "sort", sort: byEmail },
      { type: "next", cursor: "c1" },
    ]);
    const hidden = pagingReducer(state, { type: "hide", column: "token" });
    expect(hidden.sort).toEqual(byEmail);
    expect(pageNumber(hidden)).toBe(2);
  });
});

describe("filters in the paging state", () => {
  const byName = { column: "name", op: "contains" as const, value: "ann" };
  const byScore = { column: "score", op: "gte" as const, value: "3" };

  it("starts with none, and adds them in order", () => {
    expect(initialPaging().filters).toEqual([]);
    const state = run([
      { type: "addFilter", filter: byName },
      { type: "addFilter", filter: byScore },
    ]);
    expect(state.filters).toEqual([byName, byScore]);
  });

  it("starts again from the first page whenever the conditions change, because the cursors no longer fit", () => {
    const deep = run([
      { type: "next", cursor: "c1" },
      { type: "next", cursor: "c2" },
    ]);
    const added = pagingReducer(deep, { type: "addFilter", filter: byName });
    expect(pageNumber(added)).toBe(1);
    const again = pagingReducer(pagingReducer(added, { type: "next", cursor: "c9" }), {
      type: "removeFilter",
      index: 0,
    });
    expect(again.filters).toEqual([]);
    expect(pageNumber(again)).toBe(1);
    const cleared = pagingReducer(
      pagingReducer(
        run([
          { type: "addFilter", filter: byName },
          { type: "next", cursor: "c1" },
        ]),
        { type: "clearFilters" },
      ),
      { type: "pageSize", pageSize: 100 },
    );
    expect(cleared.filters).toEqual([]);
    expect(pageNumber(cleared)).toBe(1);
  });

  it("holds at most three, and ignores a fourth", () => {
    const three = run([
      { type: "addFilter", filter: byName },
      { type: "addFilter", filter: byScore },
      { type: "addFilter", filter: byName },
    ]);
    expect(three.filters).toHaveLength(3);
    expect(pagingReducer(three, { type: "addFilter", filter: byScore })).toBe(three);
  });

  it("removes the one asked for and keeps the others in order; an index that is not there changes nothing", () => {
    const state = run([
      { type: "addFilter", filter: byName },
      { type: "addFilter", filter: byScore },
      { type: "addFilter", filter: { column: "id", op: "is_null" } },
    ]);
    expect(pagingReducer(state, { type: "removeFilter", index: 1 }).filters).toEqual([
      byName,
      { column: "id", op: "is_null" },
    ]);
    expect(pagingReducer(state, { type: "removeFilter", index: 3 })).toBe(state);
    expect(pagingReducer(state, { type: "removeFilter", index: -1 })).toBe(state);
  });

  it("clearing with none changes nothing and keeps the page", () => {
    const state = run([{ type: "next", cursor: "c1" }]);
    expect(pagingReducer(state, { type: "clearFilters" })).toBe(state);
  });

  it("keeps the sort, the reveals and the page size when the conditions change", () => {
    const state = run([
      { type: "sort", sort: { column: "email", direction: "asc" } },
      { type: "reveal", column: "token" },
      { type: "pageSize", pageSize: 100 },
      { type: "addFilter", filter: byName },
    ]);
    expect(state.sort).toEqual({ column: "email", direction: "asc" });
    expect(state.reveal).toEqual(["token"]);
    expect(state.pageSize).toBe(100);
  });

  it("drops the conditions on a column that is hidden again, and starts again; other columns' stay", () => {
    const state = run([
      { type: "reveal", column: "token" },
      { type: "addFilter", filter: { column: "token", op: "starts_with", value: "a" } },
      { type: "addFilter", filter: byName },
      { type: "next", cursor: "c1" },
    ]);
    const hidden = pagingReducer(state, { type: "hide", column: "token" });
    expect(hidden.filters).toEqual([byName]);
    expect(hidden.reveal).toEqual([]);
    expect(pageNumber(hidden)).toBe(1);

    // Hiding a column nothing uses leaves the conditions and the page alone.
    const other = run([
      { type: "reveal", column: "token" },
      { type: "addFilter", filter: byName },
      { type: "next", cursor: "c1" },
    ]);
    const kept = pagingReducer(other, { type: "hide", column: "token" });
    expect(kept.filters).toEqual([byName]);
    expect(pageNumber(kept)).toBe(2);
  });

  it("drops a sort and a filter on the same hidden column together", () => {
    const state = run([
      { type: "reveal", column: "token" },
      { type: "sort", sort: { column: "token", direction: "asc" } },
      { type: "addFilter", filter: { column: "token", op: "is_not_null" } },
    ]);
    const hidden = pagingReducer(state, { type: "hide", column: "token" });
    expect(hidden.sort).toBeNull();
    expect(hidden.filters).toEqual([]);
  });
});
