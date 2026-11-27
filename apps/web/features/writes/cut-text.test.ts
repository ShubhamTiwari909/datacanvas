import { describe, expect, it } from "vitest";
import type { CellRead, EditableColumn } from "@datacanvas/database-core";
import { WRITE_MAX_CHANGE_VALUE_CHARS } from "@datacanvas/shared-types";
import {
  CUT_TEXT_LINE_ENDINGS_TEXT,
  CUT_TEXT_OPEN_TEXT,
  CUT_TEXT_TOO_LARGE_TEXT,
  canEditCutText,
  cutTextTooLongText,
  hasCarriageReturn,
  isSameText,
  newTextProblem,
  wholeValueOf,
} from "./cut-text";
import { buildEditCells, EMPTY_PENDING, pendingReducer, type PendingAction } from "./pending-cells";

const info = (over: Partial<EditableColumn> = {}): EditableColumn => ({
  name: "bio",
  dataType: "text",
  nullable: true,
  hasDefault: false,
  generated: false,
  identity: null,
  editable: true,
  inKey: false,
  ...over,
});
const column = { name: "bio", masked: false, kind: "text" as const };
const cut = { value: "x".repeat(2000), truncated: true };

describe("wholeValueOf", () => {
  const read = (over: Partial<CellRead>): CellRead => ({
    value: "v",
    tooLarge: false,
    length: 1,
    editable: true,
    ...over,
  });

  it("is editable only when the server says the whole value is", () => {
    expect(wholeValueOf(read({}))).toEqual({ kind: "editable", text: "v" });
    expect(
      wholeValueOf(read({ value: "x".repeat(100_001), length: 100_001, editable: false })),
    ).toEqual({
      kind: "read_only",
      text: "x".repeat(100_001),
      length: 100_001,
    });
  });

  it("is too large when the value was not sent", () => {
    expect(
      wholeValueOf(read({ value: null, tooLarge: true, length: 1_000_001, editable: false })),
    ).toEqual({
      kind: "too_large",
    });
  });

  it("starts a NULL (the cell changed since the page was read) as editable, not as too large", () => {
    expect(wholeValueOf(read({ value: null, length: null }))).toEqual({
      kind: "editable",
      text: null,
    });
  });
});

describe("canEditCutText", () => {
  it("is true for a cut text cell of a column that can be edited", () => {
    expect(canEditCutText(null, column, cut, info())).toBe(true);
  });

  it.each(["text", "character varying", "character varying(255)", "citext", "public.citext"])(
    "accepts the type %s",
    (dataType) => {
      expect(canEditCutText(null, column, cut, info({ dataType }))).toBe(true);
    },
  );

  it.each(["character(10)", "name", "short_text", "bytea", "text[]", "jsonb", "uuid", "integer"])(
    "does not offer it for the type %s",
    (dataType) => {
      expect(canEditCutText(null, column, cut, info({ dataType }))).toBe(false);
    },
  );

  it("is false for a cell that was not cut, NULL, or a column that is not a text column", () => {
    expect(canEditCutText(null, column, { value: "x", truncated: false }, info())).toBe(false);
    expect(canEditCutText(null, column, { value: null, truncated: false }, info())).toBe(false);
    expect(canEditCutText(null, { ...column, kind: "json" }, cut, info())).toBe(false);
  });

  it("keeps every other rule of the grid: no key, hidden, generated, part of the key, unknown column", () => {
    expect(canEditCutText("No key.", column, cut, info())).toBe(false);
    expect(canEditCutText(null, { ...column, masked: true }, cut, info())).toBe(false);
    expect(canEditCutText(null, column, cut, info({ generated: true }))).toBe(false);
    expect(canEditCutText(null, column, cut, info({ inKey: true }))).toBe(false);
    expect(canEditCutText(null, column, cut, info({ editable: false }))).toBe(false);
    expect(canEditCutText(null, column, cut, undefined)).toBe(false);
  });
});

describe("the change a cut cell makes", () => {
  it("is checked against the WHOLE value that was read, never the cut text", () => {
    const whole = "w".repeat(5000);
    const state = pendingReducer(EMPTY_PENDING, {
      type: "set",
      key: [{ column: "id", value: "1" }],
      column: "bio",
      before: whole,
      after: whole + " more",
    });
    const change = buildEditCells({ schema: "public", name: "t" }, state, [])!;
    expect(change.rows[0]!.changes).toEqual([
      { column: "bio", value: whole + " more", expected: whole },
    ]);
    expect(change.rows[0]!.changes[0]!.expected).not.toBe(cut.value);
  });

  it("is taken away when the text goes back to the value that was read", () => {
    const set = (after: string): PendingAction => ({
      type: "set",
      key: [{ column: "id", value: "1" }],
      column: "bio",
      before: "orig",
      after,
    });
    const state = [set("other"), set("orig")].reduce(pendingReducer, EMPTY_PENDING);
    expect(state.rows).toEqual([]);
  });
});

describe("the words", () => {
  it("say why a value is too long to edit, and how long it is", () => {
    expect(cutTextTooLongText(150_000)).toBe(
      "This value is 150,000 characters long. It is longer than 100,000 characters, which is the most a change can carry, so it can be read and copied here but not edited.",
    );
    expect(cutTextTooLongText(null)).toContain("is longer than 100,000 characters");
  });

  it("say why a value is too large to read", () => {
    expect(CUT_TEXT_TOO_LARGE_TEXT).toContain("longer than 1 million characters");
    expect(CUT_TEXT_OPEN_TEXT).toContain("Open it to edit the whole value");
  });

  it("refuse a new text over what a change carries, and no more", () => {
    expect(newTextProblem("x".repeat(WRITE_MAX_CHANGE_VALUE_CHARS))).toBeNull();
    expect(newTextProblem("x".repeat(WRITE_MAX_CHANGE_VALUE_CHARS + 1))).toBe(
      "This is longer than 100,000 characters, which is the most a change can carry.",
    );
  });
});

describe("a value with carriage returns", () => {
  it("is not edited: a text field would turn its CRLF into LF and rewrite parts the person never touched", () => {
    expect(hasCarriageReturn("a\r\nb")).toBe(true);
    expect(hasCarriageReturn("a\rb")).toBe(true);
    expect(hasCarriageReturn("a\nb")).toBe(false);
    expect(hasCarriageReturn("")).toBe(false);
    expect(hasCarriageReturn(null)).toBe(false);
    expect(CUT_TEXT_LINE_ENDINGS_TEXT).toBe(
      "This value has Windows line endings (or a bare carriage return), which this editor cannot keep exactly. Use the row form or SQL.",
    );
  });

  it("is not changed by the normalization of its line endings alone", () => {
    expect(isSameText("a\r\nb\rc", "a\nb\nc")).toBe(true);
    expect(isSameText("a\r\nb", "a\r\nb")).toBe(true);
    expect(isSameText("a\r\nb", "a\nb!")).toBe(false);
    expect(isSameText("a\nb", "a\r\nb")).toBe(false);
    expect(isSameText(null, "")).toBe(false);
    expect(isSameText(null, null)).toBe(true);
  });

  it("is not kept as a pending change when set to its own normalized text", () => {
    const set: PendingAction = {
      type: "set",
      key: [{ column: "id", value: "1" }],
      column: "bio",
      before: "a\r\nb",
      after: "a\nb",
    };
    expect(pendingReducer(EMPTY_PENDING, set).rows).toEqual([]);
    expect(pendingReducer(EMPTY_PENDING, { ...set, after: "a\nb!" }).rows).toHaveLength(1);
  });
});
