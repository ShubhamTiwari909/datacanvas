import { defuse as coreDefuse } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { defuse as sqlDefuse } from "@/features/sql/export";

/**
 * The file export (core) and the SQL tab's export (web) make a value safe for a spreadsheet by one rule
 * written twice, because the core has no web code. This pins them to each other.
 */
describe("defuse is one rule in two places", () => {
  const samples = [
    "",
    "plain",
    "=1+1",
    "+1",
    "-5",
    "-1.5e3",
    "-x",
    "@sum(a)",
    "|calc",
    "\t=x",
    "\n=x",
    "\r+1",
    " =1",
    "  \t@x",
    "\u0001=1",
    "\u0000\u0001-cmd",
    "a=b",
    "'=quoted",
    "12abc",
    "1e5",
    "- 5",
    "−5",
  ];
  it.each(samples)("agrees on %j", (value) => {
    expect(coreDefuse(value)).toBe(sqlDefuse(value));
  });
});
