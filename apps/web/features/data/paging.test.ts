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
    expect(state).toEqual({ pageSize: 50, trail: [null], reveal: [] });
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

  it("never holds row data: the state is only a size, cursors and column names", () => {
    const state = run([
      { type: "next", cursor: "c1" },
      { type: "reveal", column: "token" },
    ]);
    expect(Object.keys(state).sort()).toEqual(["pageSize", "reveal", "trail"]);
    expect(state.trail.every((c) => c === null || typeof c === "string")).toBe(true);
  });
});
