import { describe, expect, it } from "vitest";
import { validateRequestFor } from "./validation";

const table = { schema: "public", name: "t" };

describe("validateRequestFor", () => {
  it("asks about an insert with the values given, NULL kept apart from the empty string", () => {
    expect(
      validateRequestFor({
        kind: "insert_row",
        table,
        values: [
          { column: "a", value: "x" },
          { column: "b", value: null },
          { column: "c", value: "" },
        ],
      }),
    ).toEqual({
      schema: "public",
      table: "t",
      mode: "insert",
      columns: ["a", "b", "c"],
      rows: [["x", null, ""]],
    });
  });

  it("asks about an update with the new values and the key, and not what the person saw", () => {
    const request = validateRequestFor({
      kind: "update_row",
      table,
      key: [{ column: "id", value: "7" }],
      set: [{ column: "a", value: "new" }],
      expected: [{ column: "a", value: "old" }],
    });
    expect(request).toEqual({
      schema: "public",
      table: "t",
      mode: "update",
      columns: ["a"],
      rows: [["new"]],
      key: [{ column: "id", value: "7" }],
    });
    expect(JSON.stringify(request)).not.toContain("old");
  });
});
