import { describe, expect, it } from "vitest";
import {
  ROWS_CELL_CHARS,
  ROWS_MAX_CURSOR_CHARS,
  ROWS_MAX_OFFSET,
  ROWS_MAX_PAGE_SIZE,
  ROWS_MAX_RESPONSE_CHARS,
  type RowColumn,
} from "./models.js";
import {
  buildRowPage,
  decodeRowsCursor,
  encodeRowsCursor,
  isSensitiveColumnName,
  normalizeRowsOptions,
  type RawRow,
} from "./rows.js";

describe("isSensitiveColumnName", () => {
  it.each([
    "password",
    "user_password",
    "PASSWORD",
    "passwd",
    "passphrase",
    "password_hash",
    "secret",
    "client_secret",
    "api_key",
    "apiKey",
    "API-KEY",
    "private_key",
    "access_key",
    "access_token",
    "refresh_token",
    "credentials",
    "salt",
    "password_salt",
    "pwd",
    "Mot de passe secret",
  ])("masks %s", (name) => {
    expect(isSensitiveColumnName(name)).toBe(true);
  });

  it.each([
    "id",
    "email",
    "full_name",
    "created_at",
    "notes",
    "asphalt",
    "salty",
    "assault",
    "keyboard",
    "order_id",
    "naïve",
    "",
  ])("does not mask %s", (name) => {
    expect(isSensitiveColumnName(name)).toBe(false);
  });

  it("is only a hint: a harmless name that contains a word is masked, and can be revealed", () => {
    expect(isSensitiveColumnName("token_count")).toBe(true);
  });
});

describe("rows cursor", () => {
  it("round-trips a key, including quotes, Unicode, emoji, a lone surrogate and spaces", () => {
    for (const values of [
      ["1"],
      ["a", "b"],
      ['quo"te', "back\\slash", "new\nline", "tab\t"],
      ["日本語", "naïve", "🙂", "\ud800", ""],
      ["x".repeat(2999)],
    ]) {
      expect(decodeRowsCursor(encodeRowsCursor({ kind: "keyset", values }))).toEqual({
        kind: "keyset",
        values,
      });
    }
  });

  it("round-trips an offset", () => {
    for (const offset of [0, 1, 50, ROWS_MAX_OFFSET]) {
      expect(decodeRowsCursor(encodeRowsCursor({ kind: "offset", offset }))).toEqual({
        kind: "offset",
        offset,
      });
    }
  });

  it("is plain ASCII that is safe in a URL or a JSON string", () => {
    const text = encodeRowsCursor({ kind: "keyset", values: ["日本語 🙂", '"'] });
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  const forged = (json: string): string => {
    // A valid base64url of arbitrary JSON text, built the same way the module does.
    const bytes = [...json].map((c) => c.charCodeAt(0));
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += chars[(n >> 18) & 63]! + chars[(n >> 12) & 63]!;
      if (i + 1 < bytes.length) out += chars[(n >> 6) & 63]!;
      if (i + 2 < bytes.length) out += chars[n & 63]!;
    }
    return out;
  };

  it.each([
    ["empty", ""],
    ["not base64url", "not a cursor!"],
    ["standard base64 characters", "ab+/"],
    ["a length base64 can never have", "Q"],
    ["not JSON", forged("hello")],
    ["JSON that is not an object", forged("[1]")],
    ["null", forged("null")],
    ["an unknown key", forged('{"x":1}')],
    ["two keys", forged('{"k":["1"],"o":1}')],
    ["a key list that is empty", forged('{"k":[]}')],
    ["a key list with a number", forged('{"k":[1]}')],
    ["a key list with 33 values", forged(JSON.stringify({ k: Array(33).fill("1") }))],
    ["a key value with a NUL", forged('{"k":["a\\u0000b"]}')],
    ["a key value that is too long", forged(JSON.stringify({ k: ["x".repeat(3001)] }))],
    ["a negative offset", forged('{"o":-1}')],
    ["a fractional offset", forged('{"o":1.5}')],
    ["an offset past the maximum", forged(`{"o":${ROWS_MAX_OFFSET + 1}}`)],
    ["an offset that is text", forged('{"o":"5"}')],
  ])("refuses %s with a fixed message that does not repeat it", (_name, text) => {
    expect.assertions(3);
    try {
      decodeRowsCursor(text);
    } catch (error) {
      expect(error).toMatchObject({ name: "DatabaseError", code: "invalid_request" });
      expect(String((error as Error).message)).not.toContain(text || "\u0001");
      expect((error as Error).message).toBe(
        "The request could not be used. The page size or the paging position is not valid for this table.",
      );
    }
  });

  it("refuses a cursor longer than the limit", () => {
    expect(() => decodeRowsCursor("a".repeat(ROWS_MAX_CURSOR_CHARS + 1))).toThrow();
  });

  it("refuses bytes outside ASCII (nothing this module writes contains them)", () => {
    // 0xC3 0xA9 is "é" in UTF-8; base64url "w6k".
    expect(() => decodeRowsCursor("w6k")).toThrow();
  });
});

describe("normalizeRowsOptions", () => {
  const ok = { pageSize: 50, cursor: null, revealColumns: [] };

  it("accepts the limits and decodes a cursor", () => {
    expect(normalizeRowsOptions({ ...ok, pageSize: 1 }).pageSize).toBe(1);
    expect(normalizeRowsOptions({ ...ok, pageSize: ROWS_MAX_PAGE_SIZE }).pageSize).toBe(
      ROWS_MAX_PAGE_SIZE,
    );
    const cursor = encodeRowsCursor({ kind: "offset", offset: 5 });
    expect(normalizeRowsOptions({ ...ok, cursor }).cursor).toEqual({ kind: "offset", offset: 5 });
    expect([...normalizeRowsOptions({ ...ok, revealColumns: ["a", "b"] }).reveal]).toEqual([
      "a",
      "b",
    ]);
  });

  it.each([
    ["a page size of 0", { ...ok, pageSize: 0 }],
    ["a negative page size", { ...ok, pageSize: -1 }],
    ["a page size over the maximum", { ...ok, pageSize: ROWS_MAX_PAGE_SIZE + 1 }],
    ["a fractional page size", { ...ok, pageSize: 2.5 }],
    ["a page size that is text", { ...ok, pageSize: "50" as unknown as number }],
    ["NaN", { ...ok, pageSize: Number.NaN }],
    ["a cursor that is not text", { ...ok, cursor: 5 as unknown as string }],
    ["a bad cursor", { ...ok, cursor: "nonsense!" }],
    ["reveal names that are not a list", { ...ok, revealColumns: "a" as unknown as string[] }],
    ["a reveal name that is not text", { ...ok, revealColumns: [1] as unknown as string[] }],
    ["a reveal name that is too long", { ...ok, revealColumns: ["x".repeat(256)] }],
    ["too many reveal names", { ...ok, revealColumns: Array(1001).fill("a") }],
  ])("refuses %s", (_name, options) => {
    expect(() => normalizeRowsOptions(options)).toThrowError(
      expect.objectContaining({ code: "invalid_request" }) as Error,
    );
  });
});

describe("buildRowPage", () => {
  const columns: RowColumn[] = [
    { name: "id", dataType: "integer", masked: false },
    { name: "note", dataType: "text", masked: false },
    { name: "password", dataType: "text", masked: true },
  ];
  const keyed = { kind: "primary_key" as const, columns: ["id"] };
  const row = (id: number, note: string | null, secret = "hunter2"): RawRow => ({
    cells: [String(id), note, secret],
    key: [String(id)],
  });
  const page = (
    rawRows: RawRow[],
    pageSize = 2,
    extra: Partial<Parameters<typeof buildRowPage>[0]> = {},
  ) =>
    buildRowPage({
      columns,
      hiddenColumns: 0,
      order: keyed,
      rawRows,
      pageSize,
      offset: 0,
      ...extra,
    });

  it("returns the cells in column order, and never the value of a masked column", () => {
    const result = page([row(1, "a")]);
    expect(result.rows).toEqual([
      [
        { value: "1", truncated: false },
        { value: "a", truncated: false },
        { value: null, truncated: false },
      ],
    ]);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(result.columns[2]).toMatchObject({ name: "password", masked: true });
  });

  it("keeps NULL and the empty string apart", () => {
    const result = page([row(1, null), row(2, "")]);
    expect(result.rows[0]![1]).toEqual({ value: null, truncated: false });
    expect(result.rows[1]![1]).toEqual({ value: "", truncated: false });
  });

  it("cuts a long value to the cell limit and flags it, without splitting an emoji", () => {
    const long = `${"a".repeat(ROWS_CELL_CHARS - 1)}🙂tail`;
    const cell = page([row(1, long)]).rows[0]![1]!;
    expect(cell.truncated).toBe(true);
    expect(cell.value!.length).toBeLessThanOrEqual(ROWS_CELL_CHARS);
    expect(/[\ud800-\udbff]$/.test(cell.value!)).toBe(false);
    const exact = "b".repeat(ROWS_CELL_CHARS);
    expect(page([row(1, exact)]).rows[0]![1]).toEqual({ value: exact, truncated: false });
  });

  it("uses the extra row only to say there is more, and points the cursor at the last row shown", () => {
    const result = page([row(1, "a"), row(2, "b"), row(3, "c")], 2);
    expect(result.rows).toHaveLength(2);
    expect(decodeRowsCursor(result.nextCursor!)).toEqual({ kind: "keyset", values: ["2"] });
  });

  it("has no next cursor on the last page", () => {
    expect(page([row(1, "a"), row(2, "b")], 2).nextCursor).toBeNull();
    expect(page([], 2).nextCursor).toBeNull();
  });

  it("stops before the response gets too big, but always keeps one row", () => {
    const big = "x".repeat(ROWS_CELL_CHARS);
    const cellsPerRow = 1000; // more than fits: each row is about 2000 * columns characters
    const wide: RowColumn[] = Array.from({ length: cellsPerRow }, (_, i) => ({
      name: `c${i}`,
      dataType: "text",
      masked: false,
    }));
    const rawRows: RawRow[] = Array.from({ length: 5 }, (_, i) => ({
      cells: Array(cellsPerRow).fill(big) as string[],
      key: [String(i)],
    }));
    const result = buildRowPage({
      columns: wide,
      hiddenColumns: 0,
      order: keyed,
      rawRows,
      pageSize: 5,
      offset: 0,
    });
    // One row is 2,000,000 characters: exactly the limit, so one row fits and the next does not.
    expect(result.rows).toHaveLength(1);
    expect(result.cutBySize).toBe(true);
    expect(decodeRowsCursor(result.nextCursor!)).toEqual({ kind: "keyset", values: ["0"] });
    expect(ROWS_CELL_CHARS * cellsPerRow).toBe(ROWS_MAX_RESPONSE_CHARS);
  });

  it("keeps a single row even when it alone is over the limit", () => {
    const wide: RowColumn[] = Array.from({ length: 1100 }, (_, i) => ({
      name: `c${i}`,
      dataType: "text",
      masked: false,
    }));
    const raw: RawRow = {
      cells: Array(1100).fill("y".repeat(ROWS_CELL_CHARS)) as string[],
      key: ["1"],
    };
    const result = buildRowPage({
      columns: wide,
      hiddenColumns: 0,
      order: keyed,
      rawRows: [raw],
      pageSize: 1,
      offset: 0,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.cutBySize).toBe(false);
  });

  describe("a table without a key", () => {
    const none = { kind: "none" as const, columns: [] };
    const unkeyed = (n: number): RawRow[] =>
      Array.from({ length: n }, (_, i) => ({ cells: [String(i), "n", "s"], key: null }));

    it("pages by position", () => {
      const result = buildRowPage({
        columns,
        hiddenColumns: 0,
        order: none,
        rawRows: unkeyed(3),
        pageSize: 2,
        offset: 4,
      });
      expect(decodeRowsCursor(result.nextCursor!)).toEqual({ kind: "offset", offset: 6 });
      expect(result.offsetCapped).toBe(false);
    });

    it("stops at the maximum depth and says so, instead of giving a cursor", () => {
      const result = buildRowPage({
        columns,
        hiddenColumns: 0,
        order: none,
        rawRows: unkeyed(3),
        pageSize: 2,
        offset: ROWS_MAX_OFFSET - 2,
      });
      expect(result.nextCursor).toBeNull();
      expect(result.offsetCapped).toBe(true);
    });
  });

  it("reports how many columns were left out", () => {
    expect(page([row(1, "a")], 2, { hiddenColumns: 201 }).hiddenColumns).toBe(201);
  });
});
