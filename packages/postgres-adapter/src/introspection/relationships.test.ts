import { describe, expect, it } from "vitest";
import { deriveCardinality, referentialAction } from "./relationships.js";

describe("deriveCardinality", () => {
  it("is many-to-one when there is no unique key", () => {
    expect(deriveCardinality(["user_id"], [])).toBe("many-to-one");
  });

  it("is one-to-one when the foreign key columns are themselves unique", () => {
    expect(deriveCardinality(["user_id"], [["user_id"]])).toBe("one-to-one");
  });

  it("is many-to-one when the only unique key is unrelated to the foreign key", () => {
    expect(deriveCardinality(["user_id"], [["id"]])).toBe("many-to-one");
  });

  it("is many-to-one when the unique key is wider than the foreign key", () => {
    // UNIQUE (user_id, kind): one user can still have several rows (different kinds).
    expect(deriveCardinality(["user_id"], [["user_id", "kind"]])).toBe("many-to-one");
  });

  it("is one-to-one when a unique key is a subset of a composite foreign key", () => {
    // Rows are unique on `a` alone, so they are unique on (a, b) too.
    expect(deriveCardinality(["a", "b"], [["a"]])).toBe("one-to-one");
  });

  it("ignores an empty key", () => {
    expect(deriveCardinality(["user_id"], [[]])).toBe("many-to-one");
  });
});

describe("referentialAction", () => {
  it.each([
    ["a", "no_action"],
    ["r", "restrict"],
    ["c", "cascade"],
    ["n", "set_null"],
    ["d", "set_default"],
  ] as const)("maps %s to %s", (code, expected) => {
    expect(referentialAction(code)).toBe(expected);
  });
});
