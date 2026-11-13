import { describe, expect, it } from "vitest";
import { quoteIdent, quoteQualified } from "./sql-text";

describe("quoteIdent", () => {
  it("quotes identifiers and doubles embedded quotes", () => {
    expect(quoteIdent("users")).toBe('"users"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(quoteIdent("; DROP TABLE x; --")).toBe('"; DROP TABLE x; --"');
    expect(quoteIdent("🚀 Mixed Case")).toBe('"🚀 Mixed Case"');
  });

  it("qualifies with the schema", () => {
    expect(quoteQualified("public", "Order Items")).toBe('"public"."Order Items"');
  });
});
