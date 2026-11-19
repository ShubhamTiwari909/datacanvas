import { describe, expect, it } from "vitest";
import { classifyTypeChange, parseType } from "./classify.js";

const risk = (from: string, to: string) => classifyTypeChange(from, to).risk;

describe("parseType", () => {
  it("reads the base, the modifiers and arrays", () => {
    expect(parseType("character varying(255)")).toEqual({
      base: "character varying",
      array: false,
      mods: [255],
    });
    expect(parseType("numeric(10,2)")).toEqual({ base: "numeric", array: false, mods: [10, 2] });
    expect(parseType("timestamp(3) with time zone")).toEqual({
      base: "timestamp with time zone",
      array: false,
      mods: [3],
    });
    expect(parseType("integer[]")).toEqual({ base: "integer", array: true, mods: [] });
    expect(parseType("text[][]").array).toBe(true);
    expect(parseType("public.mood")).toEqual({ base: "public.mood", array: false, mods: [] });
  });
});

describe("classifyTypeChange", () => {
  it("widening an integer rewrites and cannot fail; narrowing can fail but never cuts", () => {
    expect(risk("integer", "bigint")).toEqual(["lock", "rewrite"]);
    expect(risk("smallint", "integer")).toEqual(["lock", "rewrite"]);
    expect(risk("bigint", "integer")).toEqual(["lock", "rewrite", "may_fail"]);
    expect(risk("bigint", "integer")).not.toContain("destructive");
  });

  it("rounding is destructive: numeric or floating point into an integer, fewer decimals, double to real", () => {
    expect(risk("numeric(10,2)", "integer")).toContain("destructive");
    expect(risk("double precision", "bigint")).toContain("destructive");
    expect(risk("numeric(10,3)", "numeric(10,2)")).toContain("destructive");
    expect(risk("numeric", "numeric(10,2)")).toContain("destructive");
    expect(risk("double precision", "real")).toContain("destructive");
  });

  it("more digits, same decimals, is only a lock; fewer digits can fail", () => {
    expect(risk("numeric(10,2)", "numeric(12,2)")).toEqual(["lock"]);
    expect(risk("numeric(10,2)", "numeric")).toEqual(["lock"]);
    expect(risk("numeric(12,2)", "numeric(10,2)")).toEqual(["lock", "rewrite", "may_fail"]);
    expect(risk("numeric(10,2)", "numeric(12,4)")).toEqual(["lock", "rewrite"]);
  });

  it("a longer text only locks; a shorter one can fail; a fixed length pads", () => {
    expect(risk("character varying(10)", "character varying(20)")).toEqual(["lock"]);
    expect(risk("character varying(10)", "text")).toEqual(["lock"]);
    expect(risk("character varying(10)", "character varying")).toEqual(["lock"]);
    expect(risk("character varying(20)", "character varying(10)")).toEqual(["lock", "may_fail"]);
    expect(risk("text", "character varying(10)")).toEqual(["lock", "may_fail"]);
    expect(risk("character varying(10)", "character(10)")).toEqual(["lock", "rewrite", "may_fail"]);
  });

  it("dropping the time of a timestamp, or its fractions, is destructive", () => {
    expect(risk("timestamp with time zone", "date")).toContain("destructive");
    expect(risk("timestamp without time zone", "time without time zone")).toContain("destructive");
    expect(risk("timestamp(6) without time zone", "timestamp(0) without time zone")).toContain(
      "destructive",
    );
    expect(risk("timestamp(0) without time zone", "timestamp(6) without time zone")).toEqual([
      "lock",
    ]);
    expect(risk("date", "timestamp without time zone")).toEqual(["lock", "rewrite"]);
    expect(risk("timestamp without time zone", "timestamp with time zone")).toEqual([
      "lock",
      "rewrite",
    ]);
  });

  it("anything into text is possible; text into another kind needs USING and can fail", () => {
    expect(classifyTypeChange("integer", "text")).toMatchObject({
      risk: ["lock", "rewrite"],
      using: false,
    });
    expect(classifyTypeChange("text", "integer")).toMatchObject({
      risk: ["lock", "rewrite", "may_fail"],
      using: true,
    });
    expect(classifyTypeChange("character varying(10)", "uuid").using).toBe(true);
    expect(classifyTypeChange("integer", "boolean").using).toBe(true);
    expect(classifyTypeChange("boolean", "integer").using).toBe(true);
  });

  it("an unknown pair may fail and says PostgreSQL may need USING", () => {
    const change = classifyTypeChange("jsonb", "integer");
    expect(change.risk).toContain("may_fail");
    expect(change.note).toContain("USING");
    expect(classifyTypeChange("integer", "integer[]").risk).toContain("may_fail");
  });

  it("never marks a change safe by saying nothing: every change has a lock or a rewrite", () => {
    for (const [a, b] of [
      ["integer", "bigint"],
      ["text", "integer"],
      ["numeric(10,2)", "integer"],
      ["jsonb", "integer"],
    ] as const) {
      expect(risk(a, b)).toContain("lock");
    }
  });
});
