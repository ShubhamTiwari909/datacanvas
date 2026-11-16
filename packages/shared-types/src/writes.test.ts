/**
 * The write contracts: compile-time equality with the database-core types, the
 * limits mirrored from the core, and the strictness that keeps SQL out of a
 * request.
 */
import {
  COLUMN_TYPE_NAMES,
  MAX_CHANGE_COLUMNS,
  MAX_CHANGE_PARTS,
  MAX_CHANGE_VALUE_CHARS,
  MAX_COMMENT_CHARS,
  MAX_IDENTIFIER_BYTES,
  MAX_NUMERIC_PRECISION,
  MAX_TYPE_LENGTH,
  type Change,
  type RoleInfo,
  type TableEditInfo,
} from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type {
  roleInfoSchema,
  tableEditInfoSchema} from "./writes.js";
import {
  COLUMN_TYPE_NAME_LIST,
  WRITE_MAX_CHANGE_COLUMNS,
  WRITE_MAX_CHANGE_PARTS,
  WRITE_MAX_CHANGE_VALUE_CHARS,
  WRITE_MAX_COMMENT_CHARS,
  WRITE_MAX_IDENTIFIER_BYTES,
  WRITE_MAX_NUMERIC_PRECISION,
  WRITE_MAX_TYPE_LENGTH,
  applyChangeRequestSchema,
  changeSchema,
  previewChangeRequestSchema,
  unlockWritesRequestSchema,
} from "./writes.js";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertType<T extends true>(_proof?: T): void {}

assertType<Same<z.infer<typeof changeSchema>, Change>>();
assertType<Same<z.infer<typeof tableEditInfoSchema>, TableEditInfo>>();
assertType<Same<z.infer<typeof roleInfoSchema>, RoleInfo>>();

const users = { schema: "public", name: "users" };

describe("write contracts", () => {
  it("mirror the core's limits and type list", () => {
    expect(WRITE_MAX_IDENTIFIER_BYTES).toBe(MAX_IDENTIFIER_BYTES);
    expect(WRITE_MAX_CHANGE_COLUMNS).toBe(MAX_CHANGE_COLUMNS);
    expect(WRITE_MAX_CHANGE_VALUE_CHARS).toBe(MAX_CHANGE_VALUE_CHARS);
    expect(WRITE_MAX_COMMENT_CHARS).toBe(MAX_COMMENT_CHARS);
    expect(WRITE_MAX_CHANGE_PARTS).toBe(MAX_CHANGE_PARTS);
    expect(WRITE_MAX_TYPE_LENGTH).toBe(MAX_TYPE_LENGTH);
    expect(WRITE_MAX_NUMERIC_PRECISION).toBe(MAX_NUMERIC_PRECISION);
    expect([...COLUMN_TYPE_NAME_LIST]).toEqual([...COLUMN_TYPE_NAMES]);
  });

  it("accepts a well-formed update", () => {
    const change = {
      kind: "update_row",
      table: users,
      key: [{ column: "id", value: "1" }],
      set: [{ column: "email", value: null }],
      expected: [{ column: "email", value: "" }],
    };
    expect(changeSchema.parse(change)).toEqual(change);
  });

  it.each(["sql", "where", "expression", "using", "returning"])(
    "refuses a %s key anywhere",
    (key) => {
      const base = {
        kind: "update_row",
        table: users,
        key: [{ column: "id", value: "1" }],
        set: [{ column: "email", value: "x" }],
        expected: [{ column: "email", value: "y" }],
      };
      expect(changeSchema.safeParse({ ...base, [key]: "1=1" }).success).toBe(false);
      expect(changeSchema.safeParse({ ...base, table: { ...users, [key]: "x" } }).success).toBe(
        false,
      );
      expect(
        changeSchema.safeParse({ ...base, set: [{ column: "email", value: "x", [key]: "y" }] })
          .success,
      ).toBe(false);
      expect(previewChangeRequestSchema.safeParse({ change: base, [key]: "x" }).success).toBe(
        false,
      );
    },
  );

  it("refuses an update whose changed columns lack the value that was seen", () => {
    expect(
      changeSchema.safeParse({
        kind: "update_row",
        table: users,
        key: [{ column: "id", value: "1" }],
        set: [{ column: "email", value: "x" }],
        expected: [],
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown kind, type or default", () => {
    expect(changeSchema.safeParse({ kind: "run_sql", sql: "DROP TABLE x" }).success).toBe(false);
    const column = {
      name: "a",
      type: { name: "integer" },
      nullable: true,
      default: { kind: "none" },
      identity: null,
      comment: null,
    };
    const create = {
      kind: "create_table",
      schema: "public",
      name: "t",
      columns: [column],
      primaryKey: [],
      unique: [],
      foreignKeys: [],
      comment: null,
    };
    expect(changeSchema.safeParse(create).success).toBe(true);
    expect(
      changeSchema.safeParse({ ...create, columns: [{ ...column, type: { name: "serial" } }] })
        .success,
    ).toBe(false);
    expect(
      changeSchema.safeParse({
        ...create,
        columns: [{ ...column, default: { kind: "expression", value: "now()" } }],
      }).success,
    ).toBe(false);
    expect(
      changeSchema.safeParse({
        ...create,
        columns: [{ ...column, identity: "always", default: { kind: "now" } }],
      }).success,
    ).toBe(false);
  });

  it("checks new names: 63 bytes, no NUL, no outer spaces", () => {
    const rename = (to: string) =>
      changeSchema.safeParse({ kind: "rename_table", table: users, to }).success;
    expect(rename("a".repeat(63))).toBe(true);
    expect(rename("a".repeat(64))).toBe(false);
    expect(rename("é".repeat(31))).toBe(true); // 62 bytes
    expect(rename("é".repeat(32))).toBe(false); // 64 bytes
    expect(rename("")).toBe(false);
    expect(rename("a\0b")).toBe(false);
    expect(rename(" a")).toBe(false);
    expect(rename('"; DROP TABLE users; --')).toBe(true); // just a name: it is always quoted
  });

  it("keeps the other requests strict", () => {
    expect(unlockWritesRequestSchema.safeParse({ database: "shop", force: true }).success).toBe(
      false,
    );
    expect(
      applyChangeRequestSchema.safeParse({ previewId: "a".repeat(22), sql: "x" }).success,
    ).toBe(false);
    expect(applyChangeRequestSchema.safeParse({ previewId: "short" }).success).toBe(false);
  });
});
