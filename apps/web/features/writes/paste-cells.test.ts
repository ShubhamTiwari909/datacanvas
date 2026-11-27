import { describe, expect, it } from "vitest";
import { planCellPaste } from "./paste-cells";

const page = { rows: 3, columns: 4 };
const target = (r: number, c: number) => ({
  key: [{ column: "id", value: String(r) }],
  column: String(c),
  before: null,
});

describe("spreadsheet paste", () => {
  it("keeps quoted tabs and line breaks, blank cells, and whitespace", () => {
    expect(planCellPaste('"a\tb"\t\r\n"c\nd"\t  \r\n', 1, 2, page, target)).toEqual({
      cells: [
        { type: "set", ...target(1, 2), after: "a\tb" },
        { type: "set", ...target(1, 3), after: "" },
        { type: "set", ...target(2, 2), after: "c\nd" },
        { type: "set", ...target(2, 3), after: "  " },
      ],
    });
  });

  it("preserves a leading blank row in one column", () => {
    expect(planCellPaste("\r\ntext\r\n", 0, 0, page, target)).toEqual({
      cells: [
        { type: "set", ...target(0, 0), after: "" },
        { type: "set", ...target(1, 0), after: "text" },
      ],
    });
  });

  it("refuses ragged, blocked and off-page blocks", () => {
    expect(planCellPaste("a\tb\nc", 0, 0, page, target)).toHaveProperty(
      "reason",
      expect.stringMatching(/rectangular/),
    );
    expect(planCellPaste("a\tb", 0, 3, page, target)).toHaveProperty(
      "reason",
      expect.stringMatching(/fit on this page/),
    );
    expect(
      planCellPaste("a\tb", 0, 0, page, (r, c) => (c ? "This column is hidden." : target(r, c))),
    ).toEqual({
      reason: "Paste stopped at row 1, column 2. This column is hidden.",
    });
  });
});
