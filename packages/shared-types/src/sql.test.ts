/**
 * The SQL contract: the limits mirrored from the core, and the strictness of the request.
 */
import { SQL_LIMITS, type SqlRunResult } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  SQL_DEFAULT_MAX_ROWS,
  SQL_DEFAULT_TIMEOUT_MS,
  SQL_MAX_MAX_ROWS,
  SQL_MAX_TEXT_CHARS,
  SQL_MAX_TIMEOUT_MS,
  sqlRunRequestSchema,
  type SqlResult,
  type sqlResultSchema,
} from "./sql.js";

describe("the limits", () => {
  it("are the ones the core enforces", () => {
    expect(SQL_MAX_TEXT_CHARS).toBe(SQL_LIMITS.maxTextChars);
    expect(SQL_DEFAULT_MAX_ROWS).toBe(SQL_LIMITS.defaultMaxRows);
    expect(SQL_MAX_MAX_ROWS).toBe(SQL_LIMITS.maxMaxRows);
    expect(SQL_DEFAULT_TIMEOUT_MS).toBe(SQL_LIMITS.defaultTimeoutMs);
    expect(SQL_MAX_TIMEOUT_MS).toBe(SQL_LIMITS.maxTimeoutMs);
  });
});

describe("the result", () => {
  it("has the shape of the runner's answer, in both directions", () => {
    // A compile-time check: each type is assignable to the other.
    const fromSchema: SqlRunResult = {} as z.infer<typeof sqlResultSchema>;
    const toSchema: SqlResult = {} as SqlRunResult;
    expect([fromSchema, toSchema]).toHaveLength(2);
  });
});

describe("the request", () => {
  it("gives the defaults, and takes nothing but the text and two limits", () => {
    expect(sqlRunRequestSchema.parse({ text: "SELECT 1" })).toEqual({
      text: "SELECT 1",
      maxRows: SQL_DEFAULT_MAX_ROWS,
      timeoutMs: SQL_DEFAULT_TIMEOUT_MS,
    });
    for (const extra of ["sql", "query", "params", "values", "where", "connection"]) {
      expect(sqlRunRequestSchema.safeParse({ text: "SELECT 1", [extra]: "x" }).success).toBe(false);
    }
  });
});
