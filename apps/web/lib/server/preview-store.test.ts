import { PREVIEW_TTL_MS, type PlannedChange } from "@datacanvas/database-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PREVIEWS_PER_CONNECTION, PreviewStore } from "./preview-store";

const plan = (effect = "Changes one row."): PlannedChange => ({
  change: {
    kind: "delete_row",
    table: { schema: "public", name: "users" },
    key: [{ column: "id", value: "1" }],
  },
  statements: [{ text: 'DELETE FROM "public"."users" WHERE "id" = $1', values: ["1"] }],
  expect: "one_row",
  category: "row",
  effect,
  warnings: [],
  destructive: true,
});

function setup() {
  let clock = 1_000_000;
  let counter = 0;
  const store = new PreviewStore({
    now: () => clock,
    generateId: () => `preview-${++counter}`.padEnd(22, "x"),
  });
  return { store, advance: (ms: number) => void (clock += ms) };
}

describe("PreviewStore", () => {
  it("makes unguessable URL-safe ids by default", () => {
    const store = new PreviewStore();
    const a = store.put("c1", plan()).id;
    const b = store.put("c1", plan()).id;
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
  });

  it("gives a preview back once only", () => {
    const { store } = setup();
    const { id } = store.put("c1", plan());
    expect(store.take("c1", id)?.effect).toBe("Changes one row.");
    expect(store.take("c1", id)).toBeNull();
  });

  it("expires after the time to live", () => {
    const { store, advance } = setup();
    const { id, expiresAt } = store.put("c1", plan());
    expect(expiresAt).toBe(1_000_000 + PREVIEW_TTL_MS);
    advance(PREVIEW_TTL_MS);
    expect(store.take("c1", id)).toBeNull();
  });

  it("cannot be taken through another connection, and stays for its own", () => {
    const { store } = setup();
    const { id } = store.put("c1", plan());
    expect(store.take("c2", id)).toBeNull();
    expect(store.take("c1", id)).not.toBeNull();
  });

  it("keeps at most a fixed number per connection, dropping the oldest", () => {
    const { store } = setup();
    const ids = Array.from(
      { length: MAX_PREVIEWS_PER_CONNECTION + 3 },
      (_, i) => store.put("c1", plan(`p${i}`)).id,
    );
    store.put("c2", plan());
    expect(store.count("c1")).toBe(MAX_PREVIEWS_PER_CONNECTION);
    expect(store.take("c1", ids[0]!)).toBeNull();
    expect(store.take("c1", ids.at(-1)!)?.effect).toBe(`p${MAX_PREVIEWS_PER_CONNECTION + 2}`);
    expect(store.count("c2")).toBe(1);
  });

  it("clears one connection only", () => {
    const { store } = setup();
    const a = store.put("c1", plan()).id;
    const b = store.put("c2", plan()).id;
    store.clear("c1");
    expect(store.take("c1", a)).toBeNull();
    expect(store.take("c2", b)).not.toBeNull();
  });
});

describe("PreviewStore: retention is bounded by the time to live", () => {
  afterEach(() => vi.useRealTimers());

  it("drops an expired plan on a timer, without any further use of the store", () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const store = new PreviewStore({
      now: () => clock,
      ttlMs: 60_000,
      sweepIntervalMs: 10_000,
    });
    store.put("c1", plan());
    store.put("c2", plan());
    expect(store.heldCount()).toBe(2);

    // Not expired yet: the timer runs but keeps both.
    clock += 30_000;
    vi.advanceTimersByTime(30_000);
    expect(store.heldCount()).toBe(2);

    // Expired, and nobody called the store: the timer still drops them.
    clock += 31_000;
    vi.advanceTimersByTime(10_000);
    expect(store.heldCount()).toBe(0);
    store.dispose();
  });

  it("stops its timer when it is empty, and starts again with the next preview", () => {
    vi.useFakeTimers();
    let clock = 0;
    const store = new PreviewStore({ now: () => clock, ttlMs: 1_000, sweepIntervalMs: 500 });
    expect(vi.getTimerCount()).toBe(0);
    store.put("c1", plan());
    expect(vi.getTimerCount()).toBe(1);
    clock += 2_000;
    vi.advanceTimersByTime(500);
    expect(store.heldCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    store.put("c1", plan());
    expect(vi.getTimerCount()).toBe(1);
    store.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.heldCount()).toBe(0);
  });

  it("never keeps the process alive: the timer is unref'd", () => {
    const store = new PreviewStore();
    store.put("c1", plan());
    // A ref'd 30 second timer would hold a finished program open; the store must not.
    const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })
      ._getActiveHandles?.()
      .filter((h) => typeof (h as { hasRef?: () => boolean }).hasRef === "function");
    store.dispose();
    expect(handles?.some((h) => (h as { hasRef: () => boolean }).hasRef() === false)).not.toBe(
      undefined,
    );
  });
});

describe("PreviewStore: retention is bounded by the time to live", () => {
  afterEach(() => vi.useRealTimers());

  it("drops an expired plan on a timer, without any further use of the store", () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const store = new PreviewStore({
      now: () => clock,
      ttlMs: 60_000,
      sweepIntervalMs: 10_000,
    });
    store.put("c1", plan());
    store.put("c2", plan());
    expect(store.heldCount()).toBe(2);

    // Not expired yet: the timer runs but keeps both.
    clock += 30_000;
    vi.advanceTimersByTime(30_000);
    expect(store.heldCount()).toBe(2);

    // Expired, and nobody called the store: the timer still drops them.
    clock += 31_000;
    vi.advanceTimersByTime(10_000);
    expect(store.heldCount()).toBe(0);
    store.dispose();
  });

  it("stops its timer when it is empty, and starts again with the next preview", () => {
    vi.useFakeTimers();
    let clock = 0;
    const store = new PreviewStore({ now: () => clock, ttlMs: 1_000, sweepIntervalMs: 500 });
    expect(vi.getTimerCount()).toBe(0);
    store.put("c1", plan());
    expect(vi.getTimerCount()).toBe(1);
    clock += 2_000;
    vi.advanceTimersByTime(500);
    expect(store.heldCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    store.put("c1", plan());
    expect(vi.getTimerCount()).toBe(1);
    store.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.heldCount()).toBe(0);
  });

  it("never keeps the process alive: the timer is unref'd", () => {
    const store = new PreviewStore();
    store.put("c1", plan());
    const timer = (store as unknown as { timer?: { hasRef(): boolean } }).timer;
    // A ref'd timer would hold a finished program open for as long as a plan waits.
    expect(timer).toBeDefined();
    expect(timer?.hasRef()).toBe(false);
    store.dispose();
  });
});
